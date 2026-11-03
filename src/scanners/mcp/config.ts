import type { SourceFile } from '../../core/types.js';
import { JsonLocator, parseJsonc } from '../shared-json.js';

export interface McpServer {
  name: string;
  file: string;
  line: number;
  command?: string;
  args: string[];
  env: Record<string, string>;
  url?: string;
  /** Line of a string belonging to this server. */
  lineOf(value: string): number;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringMap(value: unknown): Record<string, string> {
  if (!isObject(value)) return {};
  return Object.fromEntries(Object.entries(value).filter((e): e is [string, string] => typeof e[1] === 'string'));
}

/** `mcpServers` in .mcp.json and .cursor/mcp.json, `servers` in .vscode/mcp.json. */
function serverMap(path: string, data: Record<string, unknown>): Record<string, unknown> {
  const key = /(?:^|\/)\.vscode\/mcp\.json$/.test(path) ? 'servers' : 'mcpServers';
  const map = data[key];
  return isObject(map) ? map : {};
}

export function parseMcpConfig(file: SourceFile): McpServer[] {
  const data = parseJsonc(file.content);
  if (!isObject(data)) return [];
  const loc = new JsonLocator(file.content);
  const servers: McpServer[] = [];
  for (const [name, value] of Object.entries(serverMap(file.path, data))) {
    if (!isObject(value)) continue;
    const offset = Math.max(0, loc.keyOffset(name));
    const line = loc.key(name);
    servers.push({
      name,
      file: file.path,
      line,
      command: typeof value.command === 'string' ? value.command : undefined,
      args: Array.isArray(value.args) ? value.args.filter((a): a is string => typeof a === 'string') : [],
      env: stringMap(value.env),
      url: typeof value.url === 'string' ? value.url : undefined,
      lineOf: (text) => (loc.keyOffset(text, offset) === -1 ? line : loc.key(text, offset)),
    });
  }
  return servers;
}
