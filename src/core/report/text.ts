import { summarize } from '../runner.js';
import { SEVERITIES } from '../types.js';
import type { Finding, Severity } from '../types.js';
import { escapeUnsafe, redactFinding } from './sanitize.js';

export interface TextOptions {
  color: boolean;
}

const COLORS: Record<Severity, string> = {
  high: '\u001b[31m', // red
  medium: '\u001b[33m', // yellow
  low: '\u001b[36m', // cyan
  info: '\u001b[90m', // grey
};
const RESET = '\u001b[0m';
const DIM = '\u001b[2m';

function location(f: Finding): string {
  return f.line > 0 ? `${f.file}:${f.line}` : f.file;
}

export function summaryLine(findings: Finding[]): string {
  if (findings.length === 0) return 'No findings';
  const summary = summarize(findings);
  const parts = SEVERITIES.filter((s) => summary[s] > 0).map((s) => `${summary[s]} ${s}`);
  const noun = findings.length === 1 ? 'finding' : 'findings';
  return `${findings.length} ${noun} (${parts.join(', ')})`;
}

/** Findings must already be sorted. */
export function formatText(findings: Finding[], opts: TextOptions): string {
  const safe = findings.map((f) => {
    const r = redactFinding(f);
    return { ...r, file: escapeUnsafe(r.file), message: escapeUnsafe(r.message), fix: escapeUnsafe(r.fix) };
  });

  const locWidth = Math.max(0, ...safe.map((f) => location(f).length));
  const idWidth = Math.max(0, ...safe.map((f) => f.ruleId.length));

  const lines: string[] = [];
  for (const f of safe) {
    // "MEDIUM" is the longest label; pad so rule IDs line up.
    const sev = `${f.severity.toUpperCase().padEnd(6)}  `;
    const sevText = opts.color ? `${COLORS[f.severity]}${sev}${RESET}` : sev;
    lines.push(`${location(f).padEnd(locWidth)}   ${sevText}${f.ruleId.padEnd(idWidth)}  ${f.message}`);
    lines.push(opts.color ? `  ${DIM}Fix: ${f.fix}${RESET}` : `  Fix: ${f.fix}`);
  }
  lines.push(summaryLine(findings));
  return `${lines.join('\n')}\n`;
}
