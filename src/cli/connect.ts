/**
 * `mcp --connect`: launches configured MCP servers and lists their tools. This
 * runs third-party code, so it lives in the CLI layer and only runs after the
 * user confirms.
 */
import { spawn } from 'node:child_process';
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

/** Launch one server over stdio, list its tools, then stop it. */
export function listServerTools(server: McpServer, baseEnv: NodeJS.ProcessEnv): Promise<McpTool[]> {
  return new Promise((resolve, reject) => {
    const env = { ...baseEnv };
    for (const [key, value] of Object.entries(server.env)) env[key] = expand(value, baseEnv);
    const command = expand(server.command!, baseEnv);
    const args = server.args.map((a) => expand(a, baseEnv));

    // npx and similar are .cmd files on Windows, which only a shell can start.
    const windows = process.platform === 'win32';
    const child = windows
      ? spawn([command, ...args].map(winQuote).join(' '), { env, shell: true, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true })
      : spawn(command, args, { env, stdio: ['pipe', 'pipe', 'ignore'] });

    const tools: unknown[] = [];
    let buffer = '';
    let received = 0;
    const finish = (err: Error | undefined): void => {
      clearTimeout(timer);
      // Closing stdin is how stdio servers are told to stop; kill alone misses a child of the Windows shell.
      child.stdin.end();
      child.kill();
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
        let message: { id?: unknown; error?: { message?: unknown }; result?: { tools?: unknown; nextCursor?: unknown } };
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }
        if (message.error) return finish(new Error(String(message.error.message)));
        if (message.id === 1) {
          send({ method: 'notifications/initialized' });
          send({ id: 2, method: 'tools/list', params: {} });
        } else if (message.id === 2) {
          if (Array.isArray(message.result?.tools)) tools.push(...message.result.tools);
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
