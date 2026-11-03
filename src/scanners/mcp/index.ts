import { listTargets } from '../../core/runner.js';
import { excerpt } from '../../core/text.js';
import type { Finding, Rule, ScanContext, Scanner, SourceProvider, SurfscanConfig } from '../../core/types.js';
import {
  findCredentialAccess,
  findHiddenContent,
  findInstructionOverride,
  findInvisibleChars,
  findUnpinnedInstalls,
} from '../rules/patterns.js';
import { JsonLocator } from '../shared-json.js';
import { matchAll, type TextMatch } from '../shared.js';
import { parseMcpConfig, type McpServer } from './config.js';
import knownHosts from './known-hosts.json' with { type: 'json' };
import { hashTool, LOCK_FILE_PATH, parseLock, toolTexts, type LockFile, type McpTool, type ToolSource } from './tools.js';

export const MCP_TARGETS = ['**/.mcp.json', '**/.cursor/mcp.json', '**/.vscode/mcp.json'];

export function findMcpTargets(provider: SourceProvider, config: SurfscanConfig): Promise<string[]> {
  return listTargets(provider, config, MCP_TARGETS);
}

const parsed = new WeakMap<ScanContext, McpServer[]>();

/** Every server configured in the discovered files. */
function serversFor(context: ScanContext): McpServer[] {
  const cached = parsed.get(context);
  if (cached) return cached;
  const out: McpServer[] = [];
  for (const file of context.files) {
    try {
      out.push(...parseMcpConfig(file));
    } catch (err) {
      context.warn(`${file.path}: could not parse MCP config (${(err as Error).message})`);
    }
  }
  parsed.set(context, out);
  return out;
}

function toolSource(context: ScanContext): ToolSource | undefined {
  return (context.options as { toolSource?: ToolSource }).toolSource;
}

/** Each tool, with the location its findings should point at. */
function locateTools(context: ScanContext, source: ToolSource): Array<{ server: string; tool: McpTool; file: string; line: number; lineOf(text: string): number }> {
  const servers = serversFor(context);
  const loc = source.content === undefined ? undefined : new JsonLocator(source.content);
  return Object.entries(source.tools).flatMap(([server, tools]) => {
    const configured = servers.find((s) => s.name === server);
    return tools.map((tool) => {
      const line = loc ? loc.key(tool.name) : (configured?.line ?? 0);
      return {
        server,
        tool,
        file: source.file ?? configured?.file ?? server,
        line,
        lineOf: (text: string) => (loc && source.content!.includes(JSON.stringify(text)) ? loc.key(text) : line),
      };
    });
  });
}

// ---------------------------------------------------------------------------
// MCP-001: injection-style text in tool descriptions
// ---------------------------------------------------------------------------

/** The `<IMPORTANT>` wrapper from published tool poisoning attacks. */
const POISON_TAG = /<\s*(?:important|system|secret|hidden)\s*>/gi;

function findPoisonTag(text: string): TextMatch[] {
  return [...matchAll(POISON_TAG, text)].map((m) => ({ index: m.index, detail: m[0] }));
}

const TEXT_DETECTORS = [findInstructionOverride, findCredentialAccess, findInvisibleChars, findHiddenContent, findPoisonTag];

// ---------------------------------------------------------------------------
// MCP-003: filesystem access to the home directory or root
// ---------------------------------------------------------------------------

function programName(command: string): string {
  return (command.split(/[\\/]/).pop() ?? command).toLowerCase().replace(/\.(?:exe|cmd|bat)$/, '');
}

const isDocker = (server: McpServer): boolean => ['docker', 'podman'].includes(programName(server.command ?? ''));

const HOME_OR_ROOT =
  /^(?:\/|~|\$HOME|\$\{HOME\}|\$\{env:HOME\}|\$\{env:USERPROFILE\}|\$\{userHome\}|%USERPROFILE%|[a-z]:|\/home\/[^/]+|\/Users\/[^/]+|[a-z]:[\\/]Users[\\/][^\\/]+)$/i;
const CREDENTIAL_DIR = /(?:^|[\\/])\.(?:ssh|aws|gnupg|kube)(?:[\\/]|$)/i;

export function isBroadPath(path: string): boolean {
  const trimmed = path.replace(/[\\/]+$/, '');
  return HOME_OR_ROOT.test(trimmed === '' ? '/' : trimmed) || CREDENTIAL_DIR.test(path);
}

function mountSource(flag: string, value: string): string | undefined {
  if (flag === '--mount') return /(?:^|,)(?:source|src)=([^,]+)/.exec(value)?.[1];
  // host:container[:options], where a Windows host path has its own colon.
  return /^((?:[a-z]:)?[^:]+):/i.exec(value)?.[1];
}

function broadAccess(server: McpServer): Array<{ what: string; source: string }> {
  const out: Array<{ what: string; source: string }> = [];
  if (isDocker(server)) {
    server.args.forEach((arg, i) => {
      const inline = /^(--volume|--mount)=(.+)$/.exec(arg);
      const flag = inline?.[1] ?? (['-v', '--volume', '--mount'].includes(arg) ? arg : undefined);
      const value = inline?.[2] ?? (flag ? server.args[i + 1] : undefined);
      if (!flag || !value) return;
      const source = mountSource(flag, value);
      if (!source) return;
      if (source.includes('docker.sock')) out.push({ what: 'the Docker socket is mounted, which gives root on the host', source: value });
      else if (isBroadPath(source)) out.push({ what: `host path ${source} is mounted`, source: value });
    });
  } else if (/filesystem|\bfs\b/i.test(`${server.name} ${server.command ?? ''} ${server.args.join(' ')}`)) {
    for (const arg of server.args) {
      if (!arg.startsWith('-') && isBroadPath(arg)) out.push({ what: `it can read and write ${arg}`, source: arg });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// MCP-004: unpinned remote packages
// ---------------------------------------------------------------------------

const DOCKER_VALUE_FLAGS = new Set([
  '-e', '--env', '--env-file', '-v', '--volume', '--mount', '--name', '--network', '--net', '-p', '--publish', '-u',
  '--user', '-w', '--workdir', '--entrypoint', '--platform', '-l', '--label', '-m', '--memory', '--cpus', '--add-host',
  '-h', '--hostname', '--pull', '--cap-add', '--cap-drop', '--security-opt',
]);

export function dockerImage(args: string[]): string | undefined {
  const run = args.indexOf('run');
  if (run === -1) return undefined;
  for (let i = run + 1; i < args.length; i++) {
    const arg = args[i]!;
    if (!arg.startsWith('-')) return arg;
    if (DOCKER_VALUE_FLAGS.has(arg)) i++;
  }
  return undefined;
}

function imagePinned(image: string): boolean {
  if (image.includes('@sha256:')) return true;
  const tag = /:([^:/]+)$/.exec(image)?.[1];
  return tag !== undefined && /^v?\d+\.\d+/.test(tag);
}

function unpinnedTarget(server: McpServer): string | undefined {
  if (isDocker(server)) {
    const image = dockerImage(server.args);
    return image && !imagePinned(image) ? `container image ${image}` : undefined;
  }
  return findUnpinnedInstalls([server.command ?? '', ...server.args].join(' '))[0]?.detail;
}

// ---------------------------------------------------------------------------
// MCP-005: plain http or unknown host
// ---------------------------------------------------------------------------

const LOOPBACK = /^(?:localhost|127(?:\.\d+){3}|\[::1\]|0\.0\.0\.0|host\.docker\.internal)$/i;
const KNOWN_HOSTS: readonly string[] = knownHosts;

/** What is wrong with a remote server URL, or undefined if nothing is. */
export function remoteProblem(value: string): string | undefined {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
  const host = url.hostname.toLowerCase();
  if (LOOPBACK.test(host)) return undefined;
  if (url.protocol === 'http:') return `connects to ${host} over plain http`;
  const known = KNOWN_HOSTS.some((k) => host === k || host.endsWith(`.${k}`));
  return known ? undefined : `connects to ${host}, which is not on the known host list`;
}

function remoteUrls(server: McpServer): string[] {
  const urls = server.url ? [server.url] : [];
  // Bridges such as mcp-remote take the URL as an argument.
  return [...urls, ...server.args.filter((a) => /^https?:\/\//i.test(a))];
}

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

async function readLock(context: ScanContext): Promise<LockFile | undefined> {
  const text = await context.provider.read(LOCK_FILE_PATH);
  if (text === undefined) return undefined;
  try {
    return parseLock(text);
  } catch (err) {
    context.warn(`${LOCK_FILE_PATH}: could not parse lock file (${(err as Error).message})`);
    return undefined;
  }
}

export const rules: Rule[] = [
  {
    id: 'MCP-001',
    severity: 'high',
    title: 'Injection-style text in tool description',
    check(context) {
      const source = toolSource(context);
      if (!source) return [];
      const out: Finding[] = [];
      for (const { server, tool, file, lineOf } of locateTools(context, source)) {
        for (const text of toolTexts(tool.definition)) {
          const details = new Set(TEXT_DETECTORS.flatMap((detect) => detect(text).map((m) => excerpt(m.detail, 90))));
          for (const detail of details) {
            out.push({
              ruleId: this.id,
              severity: this.severity,
              message: `Tool "${tool.name}" (server ${server}) has injection-style text: ${detail}`,
              file,
              line: lineOf(text),
              fix: 'do not use this server until the text is reviewed; agents follow tool descriptions that users never see',
            });
          }
        }
      }
      return out;
    },
  },
  {
    id: 'MCP-002',
    severity: 'high',
    title: 'Tool description changed since the saved lock',
    async check(context) {
      const source = toolSource(context);
      const lock = source ? await readLock(context) : undefined;
      if (!source || !lock) return [];
      const out: Finding[] = [];
      for (const { server, tool, file, line } of locateTools(context, source)) {
        const saved = lock.servers[server]?.[tool.name];
        if (saved === (await hashTool(tool))) continue;
        out.push({
          ruleId: this.id,
          severity: this.severity,
          message: saved
            ? `Tool "${tool.name}" (server ${server}) changed since the saved lock`
            : `Tool "${tool.name}" (server ${server}) is not in the saved lock`,
          file,
          line,
          fix: 'review the new description; if it is safe, save it with surfscan mcp --update-lock',
        });
      }
      return out;
    },
  },
  {
    id: 'MCP-003',
    severity: 'high',
    title: 'Server with filesystem access to the home directory or root',
    check(context) {
      return serversFor(context).flatMap((s) =>
        broadAccess(s).map(({ what, source }) => ({
          ruleId: this.id,
          severity: this.severity,
          message: `Server "${s.name}" reaches too much of the filesystem: ${what}`,
          file: s.file,
          line: s.lineOf(source),
          fix: 'limit the server to the project directory',
        })),
      );
    },
  },
  {
    id: 'MCP-004',
    severity: 'medium',
    title: 'Server launched from an unpinned remote package',
    check(context) {
      const out: Finding[] = [];
      for (const s of serversFor(context)) {
        const target = unpinnedTarget(s);
        if (!target) continue;
        out.push({
          ruleId: this.id,
          severity: this.severity,
          message: `Server "${s.name}" runs whatever is newest each time it starts: ${target}`,
          file: s.file,
          line: s.line,
          fix: 'pin an exact version (pkg@1.2.3, pkg==1.2.3) or a container image digest (image@sha256:...)',
        });
      }
      return out;
    },
  },
  {
    id: 'MCP-005',
    severity: 'medium',
    title: 'Server reached over plain http or an unknown host',
    check(context) {
      const out: Finding[] = [];
      for (const s of serversFor(context)) {
        for (const url of remoteUrls(s)) {
          const problem = remoteProblem(url);
          if (!problem) continue;
          out.push({
            ruleId: this.id,
            severity: this.severity,
            message: `Server "${s.name}" ${problem}`,
            file: s.file,
            line: s.lineOf(url),
            fix: 'use https, and confirm you trust this host; it controls the tool descriptions your agent reads',
          });
        }
      }
      return out;
    },
  },
  {
    id: 'MCP-006',
    severity: 'info',
    title: 'No lock file yet',
    async check(context) {
      if (serversFor(context).length === 0) return [];
      if ((await context.provider.read(LOCK_FILE_PATH)) !== undefined) return [];
      return [
        {
          ruleId: this.id,
          severity: this.severity,
          message: 'No MCP lock file yet, so tool description changes cannot be detected',
          file: LOCK_FILE_PATH,
          line: 0,
          fix: 'export the tool list and run surfscan mcp --tools <file.json> --update-lock, then commit the lock file',
        },
      ];
    },
  },
];

export const mcpScanner: Scanner = {
  name: 'mcp',
  rules,
  findTargets: findMcpTargets,
};
