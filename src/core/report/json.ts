import { summarize } from '../runner.js';
import type { Finding, Severity } from '../types.js';
import { redactSecrets } from '../secret-patterns.js';
import { escapeUnsafe, redactFinding } from './sanitize.js';

export const JSON_REPORT_VERSION = 1;

export interface JsonReport {
  version: number;
  summary: Record<Severity, number>;
  /** False when a check could not run, so an empty `findings` does not mean clean. */
  complete: boolean;
  warnings: string[];
  findings: Finding[];
}

export interface ReportMeta {
  warnings?: string[];
  incomplete?: boolean;
}

export function toJsonReport(findings: Finding[], meta: ReportMeta = {}): JsonReport {
  return {
    version: JSON_REPORT_VERSION,
    summary: summarize(findings),
    complete: !meta.incomplete,
    warnings: (meta.warnings ?? []).map((w) => escapeUnsafe(redactSecrets(w))),
    findings: findings.map((f) => {
      const r = redactFinding(f);
      // Fixed key order keeps output stable for diffing.
      const out: Finding =
        r.column === undefined
          ? { ruleId: r.ruleId, severity: r.severity, message: r.message, file: r.file, line: r.line, fix: r.fix }
          : { ruleId: r.ruleId, severity: r.severity, message: r.message, file: r.file, line: r.line, column: r.column, fix: r.fix };
      return out;
    }),
  };
}

export function formatJson(findings: Finding[], meta: ReportMeta = {}): string {
  return `${JSON.stringify(toJsonReport(findings, meta), null, 2)}\n`;
}
