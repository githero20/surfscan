/**
 * CLI layer: argument parsing, printing and exit codes only. Scanning logic
 * lives in core/ and scanners/.
 */
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { Command, CommanderError, Option } from 'commander';
import { CONFIG_FILE_NAME, ConfigError, DEFAULT_CONFIG, loadConfig, validateConfig } from '../core/config.js';
import { createNodeProvider } from '../core/node-provider.js';
import { formatJson, formatText } from '../core/report/index.js';
import { escapeUnsafe } from '../core/report/sanitize.js';
import { hasFailures, runScanners } from '../core/runner.js';
import { redactSecrets } from '../core/secret-patterns.js';
import { SEVERITIES } from '../core/types.js';
import type { Scanner, Severity, SourceProvider, SurfscanConfig } from '../core/types.js';
import { approvalsScanner } from '../scanners/approvals/index.js';
import { depsScanner } from '../scanners/deps/index.js';
import type { FetchLike } from '../scanners/deps/registry.js';
import { keysScanner } from '../scanners/keys/index.js';
import { parseMcpConfig, type McpServer } from '../scanners/mcp/config.js';
import { findMcpTargets, mcpScanner, unpinnedTarget } from '../scanners/mcp/index.js';
import { buildLock, LOCK_FILE_PATH, parseLock, parseToolList, type ToolSource } from '../scanners/mcp/tools.js';
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
  confirm?(question: string, opts?: { exact?: string }): Promise<boolean>;
  /** Replaces global fetch for registry lookups. Used by tests so none touch the network. */
  fetch?: FetchLike;
}

interface CommonOptions {
  format: 'text' | 'json';
  failOn: Severity;
  /** False with --no-config. */
  config?: string | false;
  color: boolean;
  strict?: boolean;
  offline?: boolean;
  tools?: string;
  connect?: boolean;
  yes?: boolean;
  allowUnpinned?: boolean;
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

/** Env names a server will receive from its config, marking the ones copied from your shell. Never values. */
function describeEnv(server: McpServer): string {
  const names = Object.entries(server.env).map(([key, value]) => {
    const fromShell = [...value.matchAll(/\$\{(?:env:)?([A-Za-z_]\w*)\}/g)].map((m) => `$${m[1]}`);
    return fromShell.length > 0 ? `${key} (from your shell: ${fromShell.join(', ')})` : key;
  });
  return names.length > 0 ? names.join(', ') : 'none';
}

async function connectSource(
  provider: SourceProvider,
  config: SurfscanConfig,
  opts: CommonOptions,
  io: CliIO,
): Promise<{ source: ToolSource; notChecked: string[]; warnings: string[]; incomplete: boolean }> {
  const servers = await configuredServers(provider, config, io);
  const warnings: string[] = [];
  const warn = (message: string): void => {
    warnings.push(message);
    io.stderr(`warning: ${safeText(message)}\n`);
  };
  let skippedUnpinned = false;
  io.stderr('WARNING: --connect runs third-party code on this machine.\n');
  io.stderr('Each server gets a minimal environment (PATH, HOME, temp folders, proxy and certificate settings)\n');
  io.stderr('plus the variables listed under env. Your other shell variables are not passed on.\n\n');

  const approved: McpServer[] = [];
  for (const s of servers) {
    if (!s.command) {
      warn(`${s.name}: skipped, --connect only launches local servers, not remote URLs`);
      continue;
    }
    const target = unpinnedTarget(s);
    io.stderr(`${safeText(s.name)}\n  runs: ${safeText([s.command, ...s.args].join(' '))}\n  env:  ${safeText(describeEnv(s))}\n`);
    if (target) io.stderr(`  NOT PINNED: it runs whatever is newest (${safeText(target)}), which may differ from what you reviewed\n`);
    if (/\$\{(?:env:)?[A-Za-z_]\w*\}/.test([s.command, ...s.args].join(' '))) {
      io.stderr('  note: ${VAR} is only expanded in env, so here it is passed as written\n');
    }

    if (opts.yes) {
      if (target && !opts.allowUnpinned) {
        warn(`${s.name}: skipped because it is not pinned (pin a version, or pass --allow-unpinned)`);
        skippedUnpinned = true;
      } else {
        approved.push(s);
      }
      continue;
    }
    if (!io.confirm) throw new UsageError('--connect needs confirmation; nothing was launched (pass --yes to skip the question)');
    const ok = target
      ? await io.confirm('  Not pinned. Type "yes" to launch it anyway: ', { exact: 'yes' })
      : await io.confirm('  Launch this server? [y/N] ');
    if (ok) approved.push(s);
    else io.stderr('  skipped\n');
  }
  if (approved.length === 0) throw new UsageError('--connect: no servers were launched');

  const tools = await connectToServers(approved, io.env, warn);
  // Declining a server at the prompt is a choice. A failure, or a skip nobody was there to decide, is not.
  const incomplete = skippedUnpinned || approved.some((s) => !(s.name in tools));
  return { source: { tools }, notChecked: servers.map((s) => s.name).filter((name) => !(name in tools)), warnings, incomplete };
}

interface LoadedTools {
  source?: ToolSource;
  warnings: string[];
  incomplete: boolean;
}

async function loadToolSource(root: string, provider: SourceProvider, config: SurfscanConfig, opts: CommonOptions, io: CliIO): Promise<LoadedTools> {
  if (opts.tools && opts.connect) throw new UsageError('use either --tools or --connect, not both');
  if (opts.updateLock && !opts.tools && !opts.connect) {
    throw new UsageError('--update-lock needs a tool list: pass --tools <file.json> or --connect');
  }

  let source: ToolSource | undefined;
  let notChecked: string[] = [];
  let warnings: string[] = [];
  let incomplete = false;
  if (opts.connect) {
    ({ source, notChecked, warnings, incomplete } = await connectSource(provider, config, opts, io));
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
    const lock = await buildLock(source.tools);
    // Servers that were skipped or failed to start keep their saved hashes, so a partial run cannot erase them.
    const saved = notChecked.length > 0 ? await readIfExists(path) : undefined;
    if (saved !== undefined) {
      try {
        const previous = parseLock(saved);
        for (const name of notChecked) if (previous.servers[name] && !lock.servers[name]) lock.servers[name] = previous.servers[name]!;
        lock.servers = Object.fromEntries(Object.entries(lock.servers).sort(([a], [b]) => a.localeCompare(b)));
      } catch {
        // An unreadable old lock is replaced, as before.
      }
    }
    await writeFile(path, `${JSON.stringify(lock, null, 2)}\n`);
    io.stderr(`wrote ${LOCK_FILE_PATH}\n`);
  }
  return { source, warnings, incomplete };
}

/** The checks a config in the scanned project turns off. That file can change in the same pull request being scanned. */
function describeProjectConfig(config: SurfscanConfig): string | undefined {
  const off = [
    config.ignore.length > 0 ? `rules ${config.ignore.join(', ')}` : '',
    config.ignorePaths.length > 0 ? `paths ${config.ignorePaths.join(', ')}` : '',
    config.deps.minAgeDays < DEFAULT_CONFIG.deps.minAgeDays ? `DEPS-004 lowered to ${config.deps.minAgeDays} days` : '',
  ].filter(Boolean);
  return off.length > 0 ? `${CONFIG_FILE_NAME} in the scanned project turns off checks: ${off.join('; ')} (--no-config ignores it)` : undefined;
}

async function runCommand(name: string, pathArg: string | undefined, opts: CommonOptions, io: CliIO): Promise<number> {
  const root = await resolveRoot(io.cwd, pathArg);
  let config: SurfscanConfig;
  let configNote: string | undefined;
  if (opts.config === false) {
    config = validateConfig({});
  } else if (opts.config) {
    config = await loadConfig(readIfExists, resolve(io.cwd, opts.config), true);
  } else {
    config = await loadConfig(readIfExists, join(root, CONFIG_FILE_NAME), false);
    configNote = describeProjectConfig(config);
  }

  const provider = createNodeProvider(root);
  const tools: LoadedTools = name === 'mcp' ? await loadToolSource(root, provider, config, opts, io) : { warnings: [], incomplete: false };

  const result = await runScanners(COMMANDS[name]!.scanners, {
    provider,
    config,
    options: { offline: opts.offline === true, toolSource: tools.source, ...(io.fetch ? { fetch: io.fetch } : {}) },
  });

  const printed = configNote ? [configNote, ...result.warnings] : result.warnings;
  for (const w of printed) io.stderr(`warning: ${safeText(w)}\n`);
  const incomplete = result.incomplete || tools.incomplete;

  if (opts.format === 'json') {
    // --connect warnings were printed as they happened, but the report must still explain them.
    io.stdout(formatJson(result.findings, { warnings: [...tools.warnings, ...printed], incomplete }));
  } else {
    const color = opts.color && io.isTTY && !io.env.NO_COLOR;
    io.stdout(formatText(result.findings, { color, incomplete }));
  }

  // Findings win: exit 1 already fails the build, and says more than 2 would.
  if (hasFailures(result.findings, opts.failOn)) return EXIT_FINDINGS;
  if (opts.strict && incomplete) {
    io.stderr('surfscan: --strict: some checks could not run, so the result is incomplete\n');
    return EXIT_ERROR;
  }
  return EXIT_OK;
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
      .option('--no-config', `ignore any ${CONFIG_FILE_NAME} in the scanned directory; use when scanning untrusted changes`)
      .option('--no-color', 'disable colored output')
      .option('--strict', 'exit 2 if any check could not run (for example the registry was unreachable)')
      .action(async (pathArg: string, opts: CommonOptions) => {
        setExit(await runCommand(name, pathArg, opts, io));
      });
    if (network) command.option('--offline', 'do not contact the npm registry; run local checks only');
    if (name === 'mcp') {
      command
        .option('--tools <file>', 'exported tool list to check (MCP-001, MCP-002)')
        .option('--connect', 'launch each configured server and list its tools; runs third-party code')
        .option('--yes', 'skip the --connect confirmation (unpinned servers are still skipped)')
        .option('--allow-unpinned', 'with --connect --yes, also launch servers that are not pinned to a version')
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
