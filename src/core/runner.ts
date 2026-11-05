import { SEVERITY_RANK } from './types.js';
import type {
  Finding,
  Scanner,
  ScanContext,
  ScanResult,
  Severity,
  SourceFile,
  SourceProvider,
  SurfscanConfig,
} from './types.js';

/** Paths never scanned, in addition to config.ignorePaths. */
export const DEFAULT_IGNORE_PATHS = ['**/node_modules/**', '**/.git/**'];

export interface RunOptions {
  provider: SourceProvider;
  config: SurfscanConfig;
  /** Scanner-specific options, passed through to rules as `context.options`. */
  options?: Record<string, unknown>;
}

export function compareFindings(a: Finding, b: Finding): number {
  return (
    SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] ||
    a.file.localeCompare(b.file) ||
    a.line - b.line ||
    (a.column ?? 0) - (b.column ?? 0) ||
    a.ruleId.localeCompare(b.ruleId)
  );
}

export function sortFindings(findings: Finding[]): Finding[] {
  return [...findings].sort(compareFindings);
}

/** Discover target files for a scanner, honouring default and configured ignores. */
export function listTargets(
  provider: SourceProvider,
  config: SurfscanConfig,
  patterns: string[],
  extraIgnore: string[] = [],
): Promise<string[]> {
  return provider.list(patterns, [...DEFAULT_IGNORE_PATHS, ...extraIgnore, ...config.ignorePaths]);
}

export async function runScanner(scanner: Scanner, opts: RunOptions): Promise<ScanResult> {
  const warnings: string[] = [];
  let incomplete = false;
  const paths = await scanner.findTargets(opts.provider, opts.config);

  for (const link of opts.provider.takeSkippedLinks?.() ?? []) {
    warnings.push(`${link}: not scanned, because surfscan does not follow links to folders or to files outside the project`);
    incomplete = true;
  }

  const readOptions = scanner.maxFileBytes === undefined ? undefined : { maxBytes: scanner.maxFileBytes };
  const files: SourceFile[] = [];
  for (const path of paths) {
    try {
      const content = await opts.provider.read(path, readOptions);
      if (content !== undefined) files.push({ path, content });
    } catch (err) {
      warnings.push(`${path}: skipped (${(err as Error).message})`);
      incomplete = true;
    }
  }

  const context: ScanContext = {
    files,
    config: opts.config,
    provider: opts.provider,
    options: opts.options ?? {},
    warn: (message, warnOpts) => {
      warnings.push(message);
      if (warnOpts?.incomplete) incomplete = true;
    },
  };

  const ignored = new Set(opts.config.ignore);
  const findings: Finding[] = [];
  for (const rule of scanner.rules) {
    if (ignored.has(rule.id)) continue;
    try {
      findings.push(...(await rule.check(context)));
    } catch (err) {
      warnings.push(`${rule.id}: rule failed (${(err as Error).message})`);
      incomplete = true;
    }
  }

  return { findings: sortFindings(findings), warnings, incomplete };
}

export async function runScanners(scanners: Scanner[], opts: RunOptions): Promise<ScanResult> {
  const findings: Finding[] = [];
  const warnings: string[] = [];
  let incomplete = false;
  for (const scanner of scanners) {
    const result = await runScanner(scanner, opts);
    findings.push(...result.findings);
    warnings.push(...result.warnings);
    incomplete ||= result.incomplete;
  }
  return { findings: sortFindings(findings), warnings, incomplete };
}

export function summarize(findings: Finding[]): Record<Severity, number> {
  const summary: Record<Severity, number> = { high: 0, medium: 0, low: 0, info: 0 };
  for (const f of findings) summary[f.severity]++;
  return summary;
}

/** True when at least one finding is at or above the threshold. */
export function hasFailures(findings: Finding[], failOn: Severity): boolean {
  return findings.some((f) => SEVERITY_RANK[f.severity] >= SEVERITY_RANK[failOn]);
}
