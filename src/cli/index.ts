/**
 * CLI layer: argument parsing, printing and exit codes only. Scanning logic
 * lives in core/ and scanners/.
 */
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { Command, CommanderError, Option } from 'commander';
import { CONFIG_FILE_NAME, ConfigError, loadConfig } from '../core/config.js';
import { createNodeProvider } from '../core/node-provider.js';
import { formatJson, formatText } from '../core/report/index.js';
import { escapeUnsafe } from '../core/report/sanitize.js';
import { hasFailures, runScanners } from '../core/runner.js';
import { redactSecrets } from '../core/secret-patterns.js';
import { SEVERITIES } from '../core/types.js';
import type { Scanner, Severity, SourceProvider, SurfscanConfig } from '../core/types.js';
import { approvalsScanner } from '../scanners/approvals/index.js';
import { depsScanner } from '../scanners/deps/index.js';
import { keysScanner } from '../scanners/keys/index.js';
import { parseMcpConfig, type McpServer } from '../scanners/mcp/config.js';
import { findMcpTargets, mcpScanner } from '../scanners/mcp/index.js';
import { buildLock, LOCK_FILE_PATH, parseToolList, type ToolSource } from '../scanners/mcp/tools.js';
import { connectToServers } from './connect.js';
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
  /** Ask the user a yes/no question. Absent when nobody can answer. */
  confirm?(question: string): Promise<boolean>;
}

interface CommonOptions {
  format: 'text' | 'json';
  failOn: Severity;
  config?: string;
  color: boolean;
  offline?: boolean;
  tools?: string;
  connect?: boolean;
  yes?: boolean;
  updateLock?: boolean;
}

const ALL_SCANNERS = [rulesScanner, mcpScanner, depsScanner, keysScanner, approvalsScanner];

const COMMANDS: Record<string, { scanners: Scanner[]; summary: string; network?: boolean }> = {
  rules: { scanners: [rulesScanner], summary: 'check agent instruction files for hidden or risky instructions' },
  mcp: { scanners: [mcpScanner], summary: 'audit MCP server configs and tool descriptions' },
  deps: { scanners: [depsScanner], summary: 'verify dependencies against the npm registry', network: true },
  keys: { scanners: [keysScanner], summary: 'find keys and secrets an agent can reach' },
  approvals: { scanners: [approvalsScanner], summary: 'find commands agents may run without asking' },
  scan: { scanners: ALL_SCANNERS, summary: 'run all scanners and merge the results', network: true },
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

const safeText = (text: string): string => escapeUnsafe(redactSecrets(text));

async function configuredServers(provider: SourceProvider, config: SurfscanConfig, io: CliIO): Promise<McpServer[]> {
  const servers: McpServer[] = [];
  for (const path of await findMcpTargets(provider, config)) {
    const content = await provider.read(path);
    if (content === undefined) continue;
    try {
      servers.push(...parseMcpConfig({ path, content }));
    } catch (err) {
      io.stderr(`warning: ${safeText(`${path}: could not parse MCP config (${(err as Error).message})`)}\n`);
    }
  }
  return servers;
}

async function connectSource(provider: SourceProvider, config: SurfscanConfig, opts: CommonOptions, io: CliIO): Promise<ToolSource> {
  const servers = await configuredServers(provider, config, io);
  const local = servers.filter((s) => s.command);
  io.stderr('WARNING: --connect runs third-party code on this machine. It will launch:\n');
  for (const s of local) io.stderr(`  ${safeText(s.name)}: ${safeText([s.command!, ...s.args].join(' '))}\n`);
  if (!opts.yes) {
    const approved = io.confirm ? await io.confirm('Launch these servers? [y/N] ') : false;
    if (!approved) throw new UsageError('--connect needs confirmation; nothing was launched (pass --yes to skip the question)');
  }
  const warn = (message: string): void => io.stderr(`warning: ${safeText(message)}\n`);
  return { tools: await connectToServers(servers, io.env, warn) };
}

async function loadToolSource(root: string, provider: SourceProvider, config: SurfscanConfig, opts: CommonOptions, io: CliIO): Promise<ToolSource | undefined> {
  if (opts.tools && opts.connect) throw new UsageError('use either --tools or --connect, not both');
  if (opts.updateLock && !opts.tools && !opts.connect) {
    throw new UsageError('--update-lock needs a tool list: pass --tools <file.json> or --connect');
  }

  let source: ToolSource | undefined;
  if (opts.connect) {
    source = await connectSource(provider, config, opts, io);
  } else if (opts.tools) {
    const content = await readIfExists(resolve(io.cwd, opts.tools));
    if (content === undefined) throw new UsageError(`tool list not found: ${opts.tools}`);
    try {
      source = { file: opts.tools.replace(/\\/g, '/'), content, tools: parseToolList(content) };
    } catch (err) {
      throw new UsageError(`${opts.tools}: invalid tool list (${(err as Error).message})`);
    }
  }

  if (source && opts.updateLock) {
    const path = join(root, LOCK_FILE_PATH);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${JSON.stringify(await buildLock(source.tools), null, 2)}\n`);
    io.stderr(`wrote ${LOCK_FILE_PATH}\n`);
  }
  return source;
}

async function runCommand(name: string, pathArg: string | undefined, opts: CommonOptions, io: CliIO): Promise<number> {
  const root = await resolveRoot(io.cwd, pathArg);
  const config = opts.config
    ? await loadConfig(readIfExists, resolve(io.cwd, opts.config), true)
    : await loadConfig(readIfExists, join(root, CONFIG_FILE_NAME), false);

  const provider = createNodeProvider(root);
  const toolSource = name === 'mcp' ? await loadToolSource(root, provider, config, opts, io) : undefined;

  const result = await runScanners(COMMANDS[name]!.scanners, {
    provider,
    config,
    options: { offline: opts.offline === true, toolSource },
  });

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

  for (const [name, { summary, network }] of Object.entries(COMMANDS)) {
    const command = program
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
    if (network) command.option('--offline', 'do not contact the npm registry; run local checks only');
    if (name === 'mcp') {
      command
        .option('--tools <file>', 'exported tool list to check (MCP-001, MCP-002)')
        .option('--connect', 'launch each configured server and list its tools; runs third-party code')
        .option('--yes', 'skip the --connect confirmation')
        .option('--update-lock', `write tool description hashes to ${LOCK_FILE_PATH}`);
    }
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
