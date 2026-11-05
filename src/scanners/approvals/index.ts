import { listTargets } from '../../core/runner.js';
import type { Finding, Rule, ScanContext, Scanner, SourceProvider, SurfscanConfig } from '../../core/types.js';
import { claudeCodeAdapter } from './adapters/claude-code.js';
import { destructiveMatch, isWildcardShell } from './destructive.js';
import type { ApprovalAdapter, ApprovalSettings } from './types.js';

/** Registered agent adapters. Add new agents here. */
export const adapters: ApprovalAdapter[] = [claudeCodeAdapter];

export function findApprovalsTargets(provider: SourceProvider, config: SurfscanConfig): Promise<string[]> {
  return listTargets(provider, config, adapters.flatMap((a) => a.targets));
}

const parsed = new WeakMap<ScanContext, ApprovalSettings[]>();

/** Parse every discovered config once per scan. */
function settingsFor(context: ScanContext): ApprovalSettings[] {
  const cached = parsed.get(context);
  if (cached) return cached;
  const out: ApprovalSettings[] = [];
  for (const file of context.files) {
    const adapter = adapters.find((a) => a.matches(file.path));
    if (!adapter) continue;
    try {
      const settings = adapter.parse(file);
      if (settings) out.push(settings);
    } catch (err) {
      context.warn(`${file.path}: could not parse ${adapter.agent} settings (${(err as Error).message})`, { incomplete: true });
    }
  }
  parsed.set(context, out);
  return out;
}

function finding(rule: Pick<Rule, 'id' | 'severity'>, file: string, line: number, message: string, fix: string): Finding {
  return { ruleId: rule.id, severity: rule.severity, message, file, line, fix };
}

export const rules: Rule[] = [
  {
    id: 'APPR-001',
    severity: 'high',
    title: 'Bypass or auto-approve mode enabled',
    check(context) {
      return settingsFor(context).flatMap((s) =>
        s.bypass.map((b) =>
          finding(
            this,
            s.file,
            b.line,
            `${s.agent} skips permission prompts: ${b.value}`,
            'remove the setting; use bypass mode only for one session inside an isolated container',
          ),
        ),
      );
    },
  },
  {
    id: 'APPR-002',
    severity: 'high',
    title: 'Allowlist includes destructive commands',
    check(context) {
      const out: Finding[] = [];
      for (const s of settingsFor(context)) {
        for (const entry of s.allow) {
          if (entry.kind !== 'shell' || isWildcardShell(entry.command)) continue;
          const why = destructiveMatch(entry.command!);
          if (!why) continue;
          out.push(
            finding(
              this,
              s.file,
              entry.line,
              `${s.agent} runs a destructive command without asking: ${entry.raw} (${why})`,
              'remove the rule or narrow it to a safe subcommand; keep destructive commands behind a prompt or in deny',
            ),
          );
        }
      }
      return out;
    },
  },
  {
    id: 'APPR-003',
    severity: 'high',
    title: 'Wildcard shell permission',
    check(context) {
      const out: Finding[] = [];
      for (const s of settingsFor(context)) {
        for (const entry of s.allow) {
          if (entry.kind !== 'shell' || !isWildcardShell(entry.command)) continue;
          out.push(
            finding(
              this,
              s.file,
              entry.line,
              `${s.agent} runs any shell command without asking: ${entry.raw}`,
              'replace the wildcard with rules for the specific commands the project needs, such as Bash(npm run test *)',
            ),
          );
        }
      }
      return out;
    },
  },
  {
    id: 'APPR-004',
    severity: 'medium',
    title: 'All project MCP servers or tools auto-approved',
    check(context) {
      const out: Finding[] = [];
      for (const s of settingsFor(context)) {
        for (const m of s.allMcpServers) {
          out.push(
            finding(
              this,
              s.file,
              m.line,
              `${s.agent} approves every project MCP server: ${m.value}`,
              'approve servers one by one after reviewing them (enabledMcpjsonServers in Claude Code)',
            ),
          );
        }
        for (const entry of s.allow) {
          if (entry.kind !== 'mcp' || entry.mcpTool !== undefined) continue;
          out.push(
            finding(
              this,
              s.file,
              entry.line,
              `${s.agent} auto-approves every tool of MCP server "${entry.mcpServer}": ${entry.raw}`,
              'allow only the specific read-only tools you need, such as mcp__server__get_issue',
            ),
          );
        }
      }
      return out;
    },
  },
  {
    id: 'APPR-005',
    severity: 'medium',
    title: 'File edits auto-approved',
    check(context) {
      return settingsFor(context).flatMap((s) =>
        s.partial.map((p) =>
          finding(
            this,
            s.file,
            p.line,
            `${s.agent} approves some actions without asking: ${p.value}`,
            'use the default mode in shared project settings; let each developer opt in for their own session',
          ),
        ),
      );
    },
  },
];

export const approvalsScanner: Scanner = {
  name: 'approvals',
  rules,
  findTargets: findApprovalsTargets,
};
