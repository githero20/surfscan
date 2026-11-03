/**
 * Claude Code settings adapter.
 *
 * Key names checked against the Claude Code documentation at
 * code.claude.com/docs/en/settings, /permissions and /settings-reference,
 * retrieved 2026-11-03 (pages reference Claude Code up to v2.1.314):
 *
 * - permissions.allow: list of rules, `Tool` or `Tool(specifier)`.
 *   `Bash` and `Bash(*)` both match every command. `*` is a wildcard that
 *   matches any text; a trailing ` *` or `:*` also matches the bare command.
 * - permissions.defaultMode: default | acceptEdits | plan | auto | dontAsk |
 *   bypassPermissions. Since v2.1.257, `auto` and `bypassPermissions` no
 *   longer take effect from project or local settings, but older versions
 *   honour them, so they are still reported (APPR-001). `acceptEdits`
 *   approves file edits and common filesystem commands (APPR-005).
 * - skipDangerousModePermissionPrompt: skips the confirmation before
 *   bypassPermissions mode.
 * - enableAllProjectMcpServers: approves every server in project .mcp.json.
 * - MCP allow rules: `mcp__<server>` and `mcp__<server>__*` cover every tool
 *   of a server; `mcp__<server>__<tool>` covers one. Unanchored globs such as
 *   `mcp__*` or `*` are skipped by Claude Code as allow rules.
 */
import { stripBom } from '../../../core/text.js';
import type { SourceFile } from '../../../core/types.js';
import { JsonLocator } from '../../shared-json.js';
import type { AllowEntry, ApprovalAdapter, ApprovalSettings } from '../types.js';

const SHELL_TOOLS = new Set(['Bash', 'PowerShell']);
/** Modes where no human approves tool calls. */
const BYPASS_MODES = new Set(['bypassPermissions', 'auto']);
/** Modes that approve file edits without asking. */
const PARTIAL_MODES = new Set(['acceptEdits']);

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseRule(raw: string, line: number): AllowEntry {
  const m = /^\s*([A-Za-z0-9_*-]+)\s*(?:\(([\s\S]*)\))?\s*$/.exec(raw);
  if (!m) return { raw, line, kind: 'other' };
  const tool = m[1]!;
  const specifier = m[2];

  if (SHELL_TOOLS.has(tool)) {
    const command = specifier?.trim();
    return { raw, line, kind: 'shell', command: command === undefined || command === '' ? undefined : command };
  }

  const mcp = /^mcp__(.+?)(?:__(.*))?$/.exec(tool);
  if (mcp && specifier === undefined) {
    const server = mcp[1]!;
    // Unanchored server globs do nothing as allow rules.
    if (server.includes('*')) return { raw, line, kind: 'other' };
    const toolPattern = mcp[2];
    return {
      raw,
      line,
      kind: 'mcp',
      mcpServer: server,
      mcpTool: toolPattern === undefined || toolPattern === '*' ? undefined : toolPattern,
    };
  }

  return { raw, line, kind: 'other' };
}

export const claudeCodeAdapter: ApprovalAdapter = {
  agent: 'Claude Code',
  targets: ['**/.claude/settings.json', '**/.claude/settings.local.json'],

  matches(path: string): boolean {
    return /(?:^|\/)\.claude\/settings(?:\.local)?\.json$/.test(path);
  },

  parse(file: SourceFile): ApprovalSettings | undefined {
    const data: unknown = JSON.parse(stripBom(file.content));
    if (!isObject(data)) return undefined;
    const loc = new JsonLocator(file.content);
    const settings: ApprovalSettings = {
      agent: this.agent,
      file: file.path,
      bypass: [],
      partial: [],
      allow: [],
      allMcpServers: [],
    };

    const permissions = isObject(data.permissions) ? data.permissions : {};
    const permOffset = Math.max(0, loc.keyOffset('permissions'));

    const mode = permissions.defaultMode;
    if (typeof mode === 'string' && BYPASS_MODES.has(mode)) {
      settings.bypass.push({
        value: `permissions.defaultMode is "${mode}" (ignored from project files since v2.1.257, honoured by older versions)`,
        line: loc.key('defaultMode', permOffset),
      });
    } else if (typeof mode === 'string' && PARTIAL_MODES.has(mode)) {
      settings.partial.push({
        value: `permissions.defaultMode is "${mode}" (file edits and filesystem commands run without asking)`,
        line: loc.key('defaultMode', permOffset),
      });
    }
    if (data.skipDangerousModePermissionPrompt === true) {
      settings.bypass.push({
        value: 'skipDangerousModePermissionPrompt is true',
        line: loc.key('skipDangerousModePermissionPrompt'),
      });
    }

    if (Array.isArray(permissions.allow)) {
      for (const rule of permissions.allow) {
        if (typeof rule !== 'string') continue;
        settings.allow.push(parseRule(rule, loc.stringValue(rule, 'allow')));
      }
    }

    if (data.enableAllProjectMcpServers === true) {
      settings.allMcpServers.push({
        value: 'enableAllProjectMcpServers is true',
        line: loc.key('enableAllProjectMcpServers'),
      });
    }

    return settings;
  },
};
