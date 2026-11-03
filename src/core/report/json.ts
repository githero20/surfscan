import { summarize } from '../runner.js';
import type { Finding, Severity } from '../types.js';
import { redactFinding } from './sanitize.js';

export const JSON_REPORT_VERSION = 1;

export interface JsonReport {
  version: number;
  summary: Record<Severity, number>;
  findings: Finding[];
}

export function toJsonReport(findings: Finding[]): JsonReport {
  return {
    version: JSON_REPORT_VERSION,
    summary: summarize(findings),
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

export function formatJson(findings: Finding[]): string {
  return `${JSON.stringify(toJsonReport(findings), null, 2)}\n`;
}
