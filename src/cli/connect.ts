/**
 * `mcp --connect`: launches configured MCP servers and lists their tools. This
 * runs third-party code, so it lives in the CLI layer and only runs after the
 * user confirms.
 */
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { join } from 'node:path';
import type { McpServer } from '../scanners/mcp/config.js';
import { parseToolList, UNNAMED_SERVER, type McpTool, type ToolList } from '../scanners/mcp/tools.js';

const TIMEOUT_MS = 30_000;
const MAX_OUTPUT_CHARS = 16 * 1024 * 1024;
const PROTOCOL_VERSION = '2025-06-18';

function expand(value: string, env: NodeJS.ProcessEnv): string {
  return value.replace(/\$\{(?:env:)?([A-Za-z_]\w*)\}/g, (whole, name: string) => env[name] ?? whole);
}

function winQuote(arg: string): string {
  return /[\s"&|<>^]/.test(arg) ? `"${arg.replace(/"/g, '""')}"` : arg;
}

/**
 * Variables a server needs just to start (find node, npx, uvx, docker; reach
 * the network through a proxy). Compared case-insensitively, since Windows
 * variable names are. Everything else in the shell, such as GITHUB_TOKEN or
 * AWS_SECRET_ACCESS_KEY, stays out unless the server's own config asks for it.
 */
const BASE_ENV_ALLOWLIST = new Set(
  [
    'PATH', 'PATHEXT', 'HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA',
    'TEMP', 'TMP', 'TMPDIR', 'SystemRoot', 'SystemDrive', 'WINDIR', 'ComSpec', 'ProgramFiles',
    'ProgramFiles(x86)', 'ProgramData', 'USER', 'USERNAME', 'LOGNAME', 'SHELL', 'TERM', 'LANG',
    'LC_ALL', 'LC_CTYPE', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME', 'HTTP_PROXY',
    'HTTPS_PROXY', 'NO_PROXY', 'ALL_PROXY', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS',
  ].map((name) => name.toLowerCase()),
);

/** The environment a launched server gets: the allowlist, plus the `env` block from its config. */
export function buildChildEnv(server: McpServer, shellEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(shellEnv)) {
    if (value !== undefined && BASE_ENV_ALLOWLIST.has(key.toLowerCase())) env[key] = value;
  }
  // ${VAR} in the env block is the one way for a shell variable to reach a server. The prompt shows
  // those names. Commands and arguments are not expanded: anyone can read a command line.
  for (const [key, value] of Object.entries(server.env)) env[key] = expand(value, shellEnv);
  return env;
}

/**
 * Stop a server and release its pipes, so surfscan can exit even if something
 * the server started keeps running. On Windows the server is a child of the
 * shell, so the whole tree has to go. taskkill is named by full path because
 * Windows searches the current folder, which here is a project being scanned.
 */
function stopServer(child: ChildProcessWithoutNullStreams): void {
  child.stdin.destroy();
  const systemRoot = process.env.SystemRoot;
  if (process.platform === 'win32' && child.pid !== undefined && systemRoot) {
    spawnSync(join(systemRoot, 'System32', 'taskkill.exe'), ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  }
  child.kill();
  child.stdout.destroy();
  child.unref();
}

/** Launch one server over stdio, list its tools, then stop it. */
export function listServerTools(server: McpServer, baseEnv: NodeJS.ProcessEnv): Promise<McpTool[]> {
  return new Promise((resolve, reject) => {
    const env = buildChildEnv(server, baseEnv);
    // Not expanded, so that a shell variable cannot reach a command line. See buildChildEnv.
    const command = server.command!;
    const args = server.args;

    // npx and similar are .cmd files on Windows, which only a shell can start.
    const windows = process.platform === 'win32';
    // cmd.exe expands %VAR% even inside quotes, so what ran would differ from what the user approved.
    if (windows && [command, ...args].some((part) => /%[^%\s]+%/.test(part))) {
      reject(new Error('%VAR% in a command or argument cannot be passed safely on Windows'));
      return;
    }
    const child = windows
      ? spawn([command, ...args].map(winQuote).join(' '), { env, shell: true, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true })
      : spawn(command, args, { env, stdio: ['pipe', 'pipe', 'ignore'] });

    const tools: unknown[] = [];
    let buffer = '';
    let received = 0;
    let finished = false;
    const finish = (err: Error | undefined): void => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      stopServer(child as unknown as ChildProcessWithoutNullStreams);
      if (err) reject(err);
      else resolve(parseToolList(JSON.stringify({ tools }))[UNNAMED_SERVER]!);
    };
    const timer = setTimeout(() => finish(new Error(`no tool list after ${TIMEOUT_MS / 1000} seconds`)), TIMEOUT_MS);
    const send = (message: object): void => {
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
    };

    child.on('error', (err) => finish(err));
    child.on('exit', (code) => finish(new Error(`server exited early with code ${code}`)));
    child.stdin.on('error', () => undefined);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      received += chunk.length;
      if (received > MAX_OUTPUT_CHARS) return finish(new Error('server sent too much output'));
      buffer += chunk;
      let newline: number;
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          continue;
        }
        // Valid JSON is not always a message: a server can print null or 42.
        if (typeof parsed !== 'object' || parsed === null) continue;
        const message = parsed as { id?: unknown; error?: { message?: unknown }; result?: { tools?: unknown; nextCursor?: unknown } };
        if (message.error) return finish(new Error(String(message.error.message)));
        if (message.id === 1) {
          send({ method: 'notifications/initialized' });
          send({ id: 2, method: 'tools/list', params: {} });
        } else if (message.id === 2) {
          // Not push(...tools): a long enough page would overflow the call stack.
          if (Array.isArray(message.result?.tools)) for (const tool of message.result.tools) tools.push(tool);
          const cursor = message.result?.nextCursor;
          if (typeof cursor === 'string' && cursor) send({ id: 2, method: 'tools/list', params: { cursor } });
          else return finish(undefined);
        }
      }
    });

    send({
      id: 1,
      method: 'initialize',
      params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'surfscan', version: '0' } },
    });
  });
}

/** Tool lists for every stdio server. A server that fails is reported and left out. */
export async function connectToServers(
  servers: McpServer[],
  env: NodeJS.ProcessEnv,
  warn: (message: string) => void,
): Promise<ToolList> {
  const tools: ToolList = {};
  for (const server of servers) {
    if (!server.command) {
      warn(`${server.name}: skipped, --connect only launches local servers, not remote URLs`);
      continue;
    }
    try {
      tools[server.name] = await listServerTools(server, env);
    } catch (err) {
      warn(`${server.name}: could not list tools (${(err as Error).message})`);
    }
  }
  return tools;
}
