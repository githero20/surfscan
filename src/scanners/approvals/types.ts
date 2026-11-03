import type { SourceFile } from '../../core/types.js';

/** A setting found in an agent config, with the line it is on. */
export interface Located<T> {
  value: T;
  line: number;
}

/** One auto-approve entry, normalized across agents. */
export interface AllowEntry {
  /** The entry as written, for messages. */
  raw: string;
  line: number;
  /** 'shell' covers Bash, PowerShell and similar command tools. */
  kind: 'shell' | 'mcp' | 'other';
  /** Shell: the command pattern (`*` is a wildcard). Undefined means every command. */
  command?: string;
  /** MCP: server name, and tool pattern (undefined means every tool). */
  mcpServer?: string;
  mcpTool?: string;
}

/** What an agent config auto-approves, in agent-neutral terms. */
export interface ApprovalSettings {
  agent: string;
  file: string;
  /** Modes or flags that skip permission prompts entirely. */
  bypass: Array<Located<string>>;
  allow: AllowEntry[];
  /** Modes that auto-approve some actions, such as file edits. */
  partial: Array<Located<string>>;
  /** Settings that auto-approve every project MCP server. */
  allMcpServers: Array<Located<string>>;
}

/**
 * Reads one agent's config format. Add an adapter per agent; rules only see
 * ApprovalSettings.
 */
export interface ApprovalAdapter {
  agent: string;
  /** Globs relative to the project root. */
  targets: string[];
  /** True when a discovered path belongs to this adapter. */
  matches(path: string): boolean;
  /** Returns undefined when the file holds nothing to check. Throws on parse errors. */
  parse(file: SourceFile): ApprovalSettings | undefined;
}
