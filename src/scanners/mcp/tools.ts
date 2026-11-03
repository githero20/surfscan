import { stripBom } from '../../core/text.js';

export const LOCK_FILE_PATH = '.surfscan/mcp.lock.json';
/** Server name for an exported list that does not say which server it came from. */
export const UNNAMED_SERVER = '*';

export interface McpTool {
  name: string;
  /** The tool as exported: description, inputSchema and so on. */
  definition: Record<string, unknown>;
}

export type ToolList = Record<string, McpTool[]>;

/** Options read from `ScanContext.options`. */
export interface ToolSource {
  /** Where the list came from, shown in findings. Omitted when read from running servers. */
  file?: string;
  /** The text of the file, used to find line numbers. */
  content?: string;
  tools: ToolList;
}

export type LockFile = { version: 1; servers: Record<string, Record<string, string>> };

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toTools(value: unknown): McpTool[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => (isObject(item) && typeof item.name === 'string' ? [{ name: item.name, definition: item }] : []));
}

function toolArray(value: unknown): unknown {
  if (Array.isArray(value)) return value;
  if (!isObject(value)) return undefined;
  if (Array.isArray(value.tools)) return value.tools;
  return isObject(value.result) ? value.result.tools : undefined;
}

/**
 * Accepts a `tools/list` result (`{ "tools": [...] }`, optionally inside a
 * JSON-RPC `result`), a bare array, or `{ "servers": { "<name>": <either> } }`.
 */
export function parseToolList(text: string): ToolList {
  const data: unknown = JSON.parse(stripBom(text));
  if (isObject(data) && isObject(data.servers)) {
    return Object.fromEntries(Object.entries(data.servers).map(([name, value]) => [name, toTools(toolArray(value))]));
  }
  const tools = toolArray(data);
  if (!Array.isArray(tools)) {
    throw new Error('expected a tools array or a "servers" object');
  }
  return { [UNNAMED_SERVER]: toTools(tools) };
}

/** Strings an agent reads from a tool definition, including nested parameter descriptions. */
export function toolTexts(node: unknown, out: string[] = []): string[] {
  if (Array.isArray(node)) {
    for (const item of node) toolTexts(item, out);
  } else if (isObject(node)) {
    for (const [key, value] of Object.entries(node)) {
      if ((key === 'description' || key === 'title') && typeof value === 'string') out.push(value);
      else toolTexts(value, out);
    }
  }
  return out;
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (!isObject(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonical(value[key])]),
  );
}

/** Hash of what the agent is told about a tool. Key order does not change it. */
export async function hashTool(tool: McpTool): Promise<string> {
  const { description, inputSchema } = tool.definition;
  const bytes = new TextEncoder().encode(JSON.stringify(canonical({ description, inputSchema })));
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `sha256:${hex}`;
}

export async function buildLock(tools: ToolList): Promise<LockFile> {
  const servers: LockFile['servers'] = {};
  for (const name of Object.keys(tools).sort()) {
    const hashes: Record<string, string> = {};
    for (const tool of [...tools[name]!].sort((a, b) => a.name.localeCompare(b.name))) {
      hashes[tool.name] = await hashTool(tool);
    }
    servers[name] = hashes;
  }
  return { version: 1, servers };
}

export function parseLock(text: string): LockFile {
  const data: unknown = JSON.parse(stripBom(text));
  if (!isObject(data) || !isObject(data.servers)) throw new Error('expected a "servers" object');
  return data as LockFile;
}
