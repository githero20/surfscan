/**
 * CLI layer: argument parsing, printing and exit codes only. Scanning logic
 * lives in core/ and scanners/.
 */
import { readFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Command, CommanderError, Option } from 'commander';
import { CONFIG_FILE_NAME, ConfigError, loadConfig } from '../core/config.js';
import { createNodeProvider } from '../core/node-provider.js';
import { formatJson, formatText } from '../core/report/index.js';
import { escapeUnsafe } from '../core/report/sanitize.js';
import { hasFailures, runScanner } from '../core/runner.js';
import { SEVERITIES } from '../core/types.js';
import type { Scanner, Severity } from '../core/types.js';
import { rulesScanner } from '../scanners/rules/index.js';
import pkg from '../../package.json' with { type: 'json' };

export const EXIT_OK = 0;
export const EXIT_FINDINGS = 1;
export const EXIT_ERROR = 2;

export interface CliIO {
  stdout(text: string): void;
  stderr(text: string): void;
  cwd: string;
  env: Record<string, string | undefined>;
  isTTY: boolean;
}

interface CommonOptions {
  format: 'text' | 'json';
  failOn: Severity;
  config?: string;
  color: boolean;
}

/** Command name to scanner. `null` marks commands not built yet. */
const SCANNERS: Record<string, { scanner: Scanner | null; summary: string }> = {
  rules: { scanner: rulesScanner, summary: 'check agent instruction files for hidden or risky instructions' },
  mcp: { scanner: null, summary: 'audit MCP server configs and tool descriptions' },
  deps: { scanner: null, summary: 'verify dependencies against the npm registry' },
  keys: { scanner: null, summary: 'find keys and secrets an agent can reach' },
  approvals: { scanner: null, summary: 'find commands agents may run without asking' },
  scan: { scanner: null, summary: 'run all scanners and merge the results' },
};

class UsageError extends Error {}

async function readIfExists(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
}

async function resolveRoot(cwd: string, pathArg: string | undefined): Promise<string> {
  const root = resolve(cwd, pathArg ?? '.');
  let isDir = false;
  try {
    isDir = (await stat(root)).isDirectory();
  } catch {
    throw new UsageError(`path not found: ${pathArg ?? '.'}`);
  }
  if (!isDir) throw new UsageError(`not a directory: ${pathArg}`);
  return root;
}

async function runCommand(name: string, pathArg: string | undefined, opts: CommonOptions, io: CliIO): Promise<number> {
  const entry = SCANNERS[name]!;
  if (!entry.scanner) {
    throw new UsageError(`"surfscan ${name}" is not available in this version yet`);
  }

  const root = await resolveRoot(io.cwd, pathArg);
  const config = opts.config
    ? await loadConfig(readIfExists, resolve(io.cwd, opts.config), true)
    : await loadConfig(readIfExists, join(root, CONFIG_FILE_NAME), false);

  const result = await runScanner(entry.scanner, { provider: createNodeProvider(root), config });

  for (const w of result.warnings) io.stderr(`warning: ${escapeUnsafe(w)}\n`);

  if (opts.format === 'json') {
    io.stdout(formatJson(result.findings));
  } else {
    const color = opts.color && io.isTTY && !io.env.NO_COLOR;
    io.stdout(formatText(result.findings, { color }));
  }

  return hasFailures(result.findings, opts.failOn) ? EXIT_FINDINGS : EXIT_OK;
}

function buildProgram(io: CliIO, setExit: (code: number) => void): Command {
  const program = new Command();
  program
    .name('surfscan')
    .description(pkg.description)
    .version(pkg.version)
    .exitOverride()
    .configureOutput({ writeOut: io.stdout, writeErr: io.stderr })
    .showHelpAfterError(false);

  for (const [name, { summary }] of Object.entries(SCANNERS)) {
    program
      .command(name)
      .description(summary)
      .argument('[path]', 'project directory to scan', '.')
      .addOption(new Option('--format <format>', 'output format').choices(['text', 'json']).default('text'))
      .addOption(new Option('--fail-on <severity>', 'exit 1 at or above this severity').choices([...SEVERITIES]).default('high'))
      .option('--config <file>', `config file (default: ${CONFIG_FILE_NAME} in the scanned directory, if present)`)
      .option('--no-color', 'disable colored output')
      .action(async (pathArg: string, opts: CommonOptions) => {
        setExit(await runCommand(name, pathArg, opts, io));
      });
  }
  return program;
}

/** Run the CLI. Returns the process exit code; never calls process.exit. */
export async function main(argv: string[], io: CliIO): Promise<number> {
  let exitCode = EXIT_OK;
  const program = buildProgram(io, (code) => {
    exitCode = code;
  });

  try {
    if (argv.length === 0) {
      program.outputHelp();
      return EXIT_ERROR;
    }
    await program.parseAsync(argv, { from: 'user' });
    return exitCode;
  } catch (err) {
    if (err instanceof CommanderError) {
      return err.code === 'commander.helpDisplayed' || err.code === 'commander.version' ? EXIT_OK : EXIT_ERROR;
    }
    if (err instanceof UsageError || err instanceof ConfigError) {
      io.stderr(`surfscan: ${err.message}\n`);
      return EXIT_ERROR;
    }
    io.stderr(`surfscan: unexpected error: ${(err as Error).message}\n`);
    return EXIT_ERROR;
  }
}
