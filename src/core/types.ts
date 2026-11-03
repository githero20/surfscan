export type Severity = 'high' | 'medium' | 'low' | 'info';

/** Highest first. */
export const SEVERITIES: readonly Severity[] = ['high', 'medium', 'low', 'info'];

export const SEVERITY_RANK: Record<Severity, number> = {
  high: 3,
  medium: 2,
  low: 1,
  info: 0,
};

export function isSeverity(value: unknown): value is Severity {
  return typeof value === 'string' && (SEVERITIES as readonly string[]).includes(value);
}

export interface Finding {
  ruleId: string;
  severity: Severity;
  /** What was found. Must never contain a full secret value. */
  message: string;
  /** Path relative to the scan root, always with forward slashes. */
  file: string;
  /** 1-based. 0 means the finding applies to the whole file. */
  line: number;
  /** 1-based. */
  column?: number;
  /** How to fix it. */
  fix: string;
}

export interface SurfscanConfig {
  /** Rule IDs to skip. */
  ignore: string[];
  /** Globs (relative to the scan root) to exclude from discovery. */
  ignorePaths: string[];
  deps: {
    minAgeDays: number;
  };
}

/**
 * Read-only access to the project being scanned. Implemented for Node in
 * `node-provider.ts`; a browser demo or test can supply an in-memory one.
 */
export interface SourceProvider {
  /** List files matching the globs, relative to the root, with forward slashes. */
  list(patterns: string[], ignore: string[]): Promise<string[]>;
  /** Read a file relative to the root. Resolves to undefined if it does not exist. */
  read(path: string): Promise<string | undefined>;
}

export interface SourceFile {
  /** Relative to the scan root, forward slashes. */
  path: string;
  content: string;
}

export interface ScanContext {
  files: SourceFile[];
  config: SurfscanConfig;
  provider: SourceProvider;
  /** Scanner-specific options (for example `offline` for deps). */
  options: Readonly<Record<string, unknown>>;
  /** Report a non-fatal problem, such as an unreadable file or a network failure. */
  warn(message: string): void;
}

export interface Rule {
  id: string;
  severity: Severity;
  title: string;
  check(context: ScanContext): Finding[] | Promise<Finding[]>;
}

export interface Scanner {
  name: string;
  /** Ordered high to low severity. */
  rules: Rule[];
  findTargets(provider: SourceProvider, config: SurfscanConfig): Promise<string[]>;
}

export interface ScanResult {
  findings: Finding[];
  warnings: string[];
}
