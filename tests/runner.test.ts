import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_CONFIG, validateConfig } from '../src/core/config.js';
import {
  compareFindings,
  DEFAULT_IGNORE_PATHS,
  hasFailures,
  listTargets,
  runScanner,
  runScanners,
  sortFindings,
  summarize,
} from '../src/core/runner.js';
import { SEVERITIES, SEVERITY_RANK } from '../src/core/types.js';
import type { Finding, Rule, ScanContext, Scanner, Severity, SourceProvider } from '../src/core/types.js';

const finding = (over: Partial<Finding> = {}): Finding => ({
  ruleId: 'TEST-001',
  severity: 'high',
  message: 'm',
  file: 'a.md',
  line: 1,
  fix: 'f',
  ...over,
});

/** An in-memory project. `list` records the globs and ignores it was given. */
function memoryProvider(files: Record<string, string | Error>) {
  const calls: Array<{ patterns: string[]; ignore: string[] }> = [];
  const provider: SourceProvider = {
    async list(patterns, ignore) {
      calls.push({ patterns, ignore });
      return Object.keys(files);
    },
    async read(path) {
      const value = files[path];
      if (value instanceof Error) throw value;
      return value;
    },
  };
  return { provider, calls };
}

function scannerOf(rules: Rule[], targets?: string[]): Scanner {
  return { name: 'test', rules, findTargets: async (provider) => targets ?? provider.list(['*'], []) };
}

const rule = (id: string, check: Rule['check'], severity: Severity = 'high'): Rule => ({ id, severity, title: id, check });

describe('runner: severity helpers', () => {
  it('ranks severities high > medium > low > info', () => {
    expect(SEVERITIES).toEqual(['high', 'medium', 'low', 'info']);
    expect(SEVERITY_RANK.high).toBeGreaterThan(SEVERITY_RANK.medium);
    expect(SEVERITY_RANK.medium).toBeGreaterThan(SEVERITY_RANK.low);
    expect(SEVERITY_RANK.low).toBeGreaterThan(SEVERITY_RANK.info);
  });

  it('summarize counts each severity and starts every count at zero', () => {
    expect(summarize([])).toEqual({ high: 0, medium: 0, low: 0, info: 0 });
    const counts = summarize([
      finding({ severity: 'high' }),
      finding({ severity: 'high' }),
      finding({ severity: 'info' }),
      finding({ severity: 'low' }),
    ]);
    expect(counts).toEqual({ high: 2, medium: 0, low: 1, info: 1 });
  });

  it.each<[Severity, Severity[], boolean]>([
    ['high', ['high'], true],
    ['high', ['medium', 'low', 'info'], false],
    ['medium', ['medium'], true],
    ['medium', ['high'], true],
    ['medium', ['low', 'info'], false],
    ['low', ['low'], true],
    ['low', ['info'], false],
    ['info', ['info'], true],
  ])('hasFailures with --fail-on %s and findings %j is %s', (threshold, severities, expected) => {
    expect(hasFailures(severities.map((severity) => finding({ severity })), threshold)).toBe(expected);
  });

  it('hasFailures is false when there are no findings, whatever the threshold', () => {
    for (const threshold of SEVERITIES) expect(hasFailures([], threshold)).toBe(false);
  });
});

describe('runner: ordering', () => {
  it('orders by severity, then file, then line, then column, then rule ID', () => {
    const unordered = [
      finding({ ruleId: 'B-001', file: 'b.md', line: 1 }),
      finding({ ruleId: 'Z-001', severity: 'info', file: 'a.md', line: 1 }),
      finding({ ruleId: 'B-002', file: 'a.md', line: 2 }),
      finding({ ruleId: 'B-003', file: 'a.md', line: 1, column: 9 }),
      finding({ ruleId: 'B-004', file: 'a.md', line: 1, column: 2 }),
      finding({ ruleId: 'C-001', file: 'a.md', line: 1 }),
      finding({ ruleId: 'A-001', file: 'a.md', line: 1 }),
      finding({ ruleId: 'M-001', severity: 'medium', file: 'a.md', line: 1 }),
    ];
    expect(sortFindings(unordered).map((f) => f.ruleId)).toEqual([
      'A-001', // no column counts as column 0
      'C-001',
      'B-004',
      'B-003',
      'B-002',
      'B-001',
      'M-001',
      'Z-001',
    ]);
  });

  it('sortFindings returns a new array and leaves the input alone', () => {
    const input = [finding({ severity: 'low' }), finding({ severity: 'high' })];
    const sorted = sortFindings(input);
    expect(sorted).not.toBe(input);
    expect(input.map((f) => f.severity)).toEqual(['low', 'high']);
  });

  it('compareFindings returns 0 for identical findings', () => {
    expect(compareFindings(finding(), finding())).toBe(0);
  });
});

describe('runner: discovering targets', () => {
  it('listTargets always excludes node_modules and .git', () => {
    expect(DEFAULT_IGNORE_PATHS).toEqual(['**/node_modules/**', '**/.git/**']);
    const { provider, calls } = memoryProvider({});
    return listTargets(provider, DEFAULT_CONFIG, ['**/*.md']).then(() => {
      expect(calls[0]!.patterns).toEqual(['**/*.md']);
      expect(calls[0]!.ignore).toEqual(expect.arrayContaining(DEFAULT_IGNORE_PATHS));
    });
  });

  it('listTargets adds scanner-specific and configured ignores', async () => {
    const { provider, calls } = memoryProvider({});
    const config = validateConfig({ ignorePaths: ['vendor/**'] });
    await listTargets(provider, config, ['*'], ['**/*.lock']);
    expect(calls[0]!.ignore).toEqual([...DEFAULT_IGNORE_PATHS, '**/*.lock', 'vendor/**']);
  });
});

describe('runner: running one scanner', () => {
  it('passes only the discovered, readable files to rules', async () => {
    const { provider } = memoryProvider({ 'a.md': 'one', 'b.md': 'two' });
    const seen: string[][] = [];
    const scanner = scannerOf([rule('T-001', (c) => (seen.push(c.files.map((f) => `${f.path}=${f.content}`)), []))]);
    await runScanner(scanner, { provider, config: DEFAULT_CONFIG });
    expect(seen).toEqual([['a.md=one', 'b.md=two']]);
  });

  it('skips a target that disappeared between discovery and reading, without a warning', async () => {
    const provider: SourceProvider = { list: async () => ['gone.md'], read: async () => undefined };
    const seen: number[] = [];
    const result = await runScanner(scannerOf([rule('T-001', (c) => (seen.push(c.files.length), []))], ['gone.md']), {
      provider,
      config: DEFAULT_CONFIG,
    });
    expect(seen).toEqual([0]);
    expect(result.warnings).toEqual([]);
    expect(result.incomplete).toBe(false);
  });

  it('passes the config, the provider and the scanner options to rules', async () => {
    const { provider } = memoryProvider({});
    const config = validateConfig({ deps: { minAgeDays: 3 } });
    let received: ScanContext | undefined;
    await runScanner(scannerOf([rule('T-001', (c) => ((received = c), []))]), { provider, config, options: { flag: 1 } });
    expect(received!.config.deps.minAgeDays).toBe(3);
    expect(received!.provider).toBe(provider);
    expect(received!.options).toEqual({ flag: 1 });
  });

  it('gives rules an empty options object when none are passed', async () => {
    const { provider } = memoryProvider({});
    let received: ScanContext | undefined;
    await runScanner(scannerOf([rule('T-001', (c) => ((received = c), []))]), { provider, config: DEFAULT_CONFIG });
    expect(received!.options).toEqual({});
  });

  it('runs rules in order and awaits asynchronous ones', async () => {
    const { provider } = memoryProvider({});
    const order: string[] = [];
    const scanner = scannerOf([
      rule('T-001', async () => {
        await new Promise((r) => setTimeout(r, 15));
        order.push('slow');
        return [finding({ ruleId: 'T-001' })];
      }),
      rule('T-002', () => {
        order.push('fast');
        return [finding({ ruleId: 'T-002', severity: 'low' })];
      }),
    ]);
    const result = await runScanner(scanner, { provider, config: DEFAULT_CONFIG });
    expect(order).toEqual(['slow', 'fast']);
    expect(result.findings.map((f) => f.ruleId)).toEqual(['T-001', 'T-002']);
  });

  it('does not run rules listed in "ignore"', async () => {
    const { provider } = memoryProvider({});
    const skipped = vi.fn(() => [finding({ ruleId: 'T-002' })]);
    const scanner = scannerOf([rule('T-001', () => [finding({ ruleId: 'T-001' })]), rule('T-002', skipped)]);
    const result = await runScanner(scanner, { provider, config: validateConfig({ ignore: ['T-002'] }) });
    expect(skipped).not.toHaveBeenCalled();
    expect(result.findings.map((f) => f.ruleId)).toEqual(['T-001']);
  });

  it('sorts the findings it returns', async () => {
    const { provider } = memoryProvider({});
    const scanner = scannerOf([
      rule('T-001', () => [finding({ severity: 'low' }), finding({ severity: 'high' })]),
    ]);
    expect((await runScanner(scanner, { provider, config: DEFAULT_CONFIG })).findings.map((f) => f.severity)).toEqual(['high', 'low']);
  });

  describe('when something could not be checked', () => {
    it('is complete when nothing went wrong', async () => {
      const { provider } = memoryProvider({ 'a.md': 'x' });
      const result = await runScanner(scannerOf([rule('T-001', () => [])]), { provider, config: DEFAULT_CONFIG });
      expect(result.incomplete).toBe(false);
      expect(result.warnings).toEqual([]);
    });

    it('a plain warning is recorded but does not make the result incomplete', async () => {
      const { provider } = memoryProvider({});
      const scanner = scannerOf([rule('T-001', (c) => (c.warn('FYI: odd file'), []))]);
      const result = await runScanner(scanner, { provider, config: DEFAULT_CONFIG });
      expect(result.warnings).toEqual(['FYI: odd file']);
      expect(result.incomplete).toBe(false);
    });

    it('a warning marked incomplete makes the result incomplete', async () => {
      const { provider } = memoryProvider({});
      const scanner = scannerOf([rule('T-001', (c) => (c.warn('registry down', { incomplete: true }), []))]);
      const result = await runScanner(scanner, { provider, config: DEFAULT_CONFIG });
      expect(result.warnings).toEqual(['registry down']);
      expect(result.incomplete).toBe(true);
    });

    it('{ incomplete: false } does not make the result incomplete', async () => {
      const { provider } = memoryProvider({});
      const scanner = scannerOf([rule('T-001', (c) => (c.warn('note', { incomplete: false }), []))]);
      expect((await runScanner(scanner, { provider, config: DEFAULT_CONFIG })).incomplete).toBe(false);
    });

    it('a file that cannot be read is skipped with a warning, the others are still scanned, and the result is incomplete', async () => {
      const { provider } = memoryProvider({ 'bad.md': new Error('EACCES: permission denied'), 'good.md': 'fine' });
      const seen: string[] = [];
      const scanner = scannerOf([rule('T-001', (c) => (seen.push(...c.files.map((f) => f.path)), []))]);
      const result = await runScanner(scanner, { provider, config: DEFAULT_CONFIG });
      expect(seen).toEqual(['good.md']);
      expect(result.warnings).toEqual(['bad.md: skipped (EACCES: permission denied)']);
      expect(result.incomplete).toBe(true);
    });

    it('a rule that throws is reported, the other rules still run, and the result is incomplete', async () => {
      const { provider } = memoryProvider({});
      const scanner = scannerOf([
        rule('T-001', () => {
          throw new Error('boom');
        }),
        rule('T-002', () => [finding({ ruleId: 'T-002' })]),
      ]);
      const result = await runScanner(scanner, { provider, config: DEFAULT_CONFIG });
      expect(result.warnings).toEqual(['T-001: rule failed (boom)']);
      expect(result.findings.map((f) => f.ruleId)).toEqual(['T-002']);
      expect(result.incomplete).toBe(true);
    });

    it('a rejected asynchronous rule is handled the same way', async () => {
      const { provider } = memoryProvider({});
      const scanner = scannerOf([rule('T-001', async () => Promise.reject(new Error('late failure')))]);
      const result = await runScanner(scanner, { provider, config: DEFAULT_CONFIG });
      expect(result.warnings).toEqual(['T-001: rule failed (late failure)']);
      expect(result.incomplete).toBe(true);
    });

    it('an ignored rule that would have failed does not make the result incomplete', async () => {
      const { provider } = memoryProvider({});
      const scanner = scannerOf([
        rule('T-001', () => {
          throw new Error('boom');
        }),
      ]);
      const result = await runScanner(scanner, { provider, config: validateConfig({ ignore: ['T-001'] }) });
      expect(result.incomplete).toBe(false);
      expect(result.warnings).toEqual([]);
    });
  });
});

describe('runner: running several scanners', () => {
  it('merges findings across scanners and sorts them together', async () => {
    const { provider } = memoryProvider({});
    const first = scannerOf([rule('T-001', () => [finding({ ruleId: 'T-001', severity: 'low' })])]);
    const second = scannerOf([rule('T-002', () => [finding({ ruleId: 'T-002', severity: 'high' })])]);
    const result = await runScanners([first, second], { provider, config: DEFAULT_CONFIG });
    expect(result.findings.map((f) => f.ruleId)).toEqual(['T-002', 'T-001']);
  });

  it('concatenates warnings in scanner order', async () => {
    const { provider } = memoryProvider({});
    const first = scannerOf([rule('T-001', (c) => (c.warn('one'), []))]);
    const second = scannerOf([rule('T-002', (c) => (c.warn('two'), []))]);
    expect((await runScanners([first, second], { provider, config: DEFAULT_CONFIG })).warnings).toEqual(['one', 'two']);
  });

  it('is incomplete when any one scanner is incomplete', async () => {
    const { provider } = memoryProvider({});
    const fine = scannerOf([rule('T-001', () => [])]);
    const broken = scannerOf([rule('T-002', (c) => (c.warn('down', { incomplete: true }), []))]);
    expect((await runScanners([fine, broken], { provider, config: DEFAULT_CONFIG })).incomplete).toBe(true);
    expect((await runScanners([broken, fine], { provider, config: DEFAULT_CONFIG })).incomplete).toBe(true);
    expect((await runScanners([fine, fine], { provider, config: DEFAULT_CONFIG })).incomplete).toBe(false);
  });

  it('with no scanners returns an empty, complete result', async () => {
    const { provider } = memoryProvider({});
    expect(await runScanners([], { provider, config: DEFAULT_CONFIG })).toEqual({ findings: [], warnings: [], incomplete: false });
  });
});
