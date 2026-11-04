import { describe, expect, it } from 'vitest';
import { formatJson, toJsonReport, JSON_REPORT_VERSION } from '../src/core/report/json.js';
import { escapeUnsafe, redactFinding } from '../src/core/report/sanitize.js';
import { formatText, summaryLine } from '../src/core/report/text.js';
import { maskSecret, redactSecrets } from '../src/core/secret-patterns.js';
import type { Finding } from '../src/core/types.js';
import { FAKE } from './helpers.js';

const finding = (over: Partial<Finding> = {}): Finding => ({
  ruleId: 'RULES-001',
  severity: 'high',
  message: 'Invisible Unicode in instruction file',
  file: 'CLAUDE.md',
  line: 14,
  fix: 'remove the hidden characters',
  ...over,
});

const ESC = '\u001b';

describe('text report', () => {
  it('prints location, severity, rule ID, message and fix, then a summary (the format in the brief)', () => {
    const out = formatText([finding()], { color: false });
    expect(out).toBe(
      [
        'CLAUDE.md:14   HIGH    RULES-001  Invisible Unicode in instruction file',
        '  Fix: remove the hidden characters',
        '1 finding (1 high)',
        '',
      ].join('\n'),
    );
  });

  it('says "No findings" when there is nothing to report', () => {
    expect(formatText([], { color: false })).toBe('No findings\n');
  });

  it('lines up the columns of several findings', () => {
    const out = formatText(
      [finding({ file: 'a.md', line: 1 }), finding({ file: 'docs/long-name.md', line: 120, severity: 'medium', ruleId: 'MCP-004' })],
      { color: false },
    ).split('\n');
    const first = out[0]!;
    const second = out[2]!;
    expect(first.indexOf('HIGH')).toBe(second.indexOf('MEDIUM'));
    expect(first.indexOf('RULES-001')).toBe(second.indexOf('MCP-004'));
  });

  it('shows only the file when the finding applies to the whole file (line 0)', () => {
    const out = formatText([finding({ file: '.surfscan/mcp.lock.json', line: 0, severity: 'info', ruleId: 'MCP-006' })], { color: false });
    expect(out.split('\n')[0]).toMatch(/^\.surfscan\/mcp\.lock\.json {3}INFO {4}MCP-006/);
    expect(out).not.toContain('mcp.lock.json:0');
  });

  it('uses the singular for one finding and the plural for several', () => {
    expect(summaryLine([finding()])).toBe('1 finding (1 high)');
    expect(summaryLine([finding(), finding()])).toBe('2 findings (2 high)');
  });

  it('lists severities in the summary from high to info and leaves out empty ones', () => {
    const findings = [finding({ severity: 'info' }), finding({ severity: 'low' }), finding({ severity: 'high' }), finding({ severity: 'medium' }), finding({ severity: 'medium' })];
    expect(summaryLine(findings)).toBe('5 findings (1 high, 2 medium, 1 low, 1 info)');
    expect(summaryLine([finding({ severity: 'low' })])).toBe('1 finding (1 low)');
  });

  it('summaryLine of nothing is "No findings"', () => {
    expect(summaryLine([])).toBe('No findings');
  });

  it('prints plain text without ANSI codes when color is off', () => {
    expect(formatText([finding()], { color: false })).not.toContain(ESC);
  });

  it('colors each severity differently when color is on', () => {
    const colors = (['high', 'medium', 'low', 'info'] as const).map((severity) => {
      const out = formatText([finding({ severity })], { color: true });
      return /\u001b\[(\d+)m/.exec(out)![1];
    });
    expect(new Set(colors).size).toBe(4);
    expect(colors[0]).toBe('31'); // red for high
  });

  it('resets color after the severity and dims the fix line', () => {
    const out = formatText([finding()], { color: true });
    expect(out).toContain(`${ESC}[31mHIGH  `);
    expect(out).toContain(`${ESC}[0m`);
    expect(out).toContain(`${ESC}[2m`);
  });

  describe('incomplete results', () => {
    it('adds a line under the summary when a check could not run', () => {
      const lines = formatText([finding()], { color: false, incomplete: true }).trimEnd().split('\n');
      expect(lines.at(-2)).toBe('1 finding (1 high)');
      expect(lines.at(-1)).toMatch(/^Incomplete: .*not a clean bill of health/);
    });

    it('adds the line even when there are no findings, so "No findings" is not read as clean', () => {
      const out = formatText([], { color: false, incomplete: true });
      expect(out.split('\n')[0]).toBe('No findings');
      expect(out).toContain('Incomplete:');
    });

    it('adds nothing when the result is complete or the option is absent', () => {
      expect(formatText([finding()], { color: false, incomplete: false })).not.toContain('Incomplete');
      expect(formatText([finding()], { color: false })).not.toContain('Incomplete');
    });
  });

  describe('safety', () => {
    it('escapes terminal control sequences in messages, fixes and file names', () => {
      const out = formatText(
        [finding({ message: `a${ESC}[2Jb`, fix: `c${ESC}]0;title\u0007d`, file: `e${ESC}[1mf.md` })],
        { color: false },
      );
      expect(out).not.toContain(ESC);
      expect(out).not.toContain('\u0007');
      expect(out).toContain('\\u001B[2J');
    });

    it('masks secrets in messages, fixes and file names', () => {
      const out = formatText([finding({ message: `key ${FAKE.__FAKE_GITHUB_TOKEN__}`, fix: `rotate ${FAKE.__FAKE_AWS_ID__}`, file: `${FAKE.__FAKE_STRIPE_LIVE__}.env` })], { color: false });
      expect(out).not.toContain(FAKE.__FAKE_GITHUB_TOKEN__);
      expect(out).not.toContain(FAKE.__FAKE_AWS_ID__);
      expect(out).not.toContain(FAKE.__FAKE_STRIPE_LIVE__);
      expect(out).toContain('ghp_...');
    });
  });
});

describe('JSON report', () => {
  it('has a version, a summary, complete, warnings and findings, in that order', () => {
    const report = JSON.parse(formatJson([finding()]));
    expect(Object.keys(report)).toEqual(['version', 'summary', 'complete', 'warnings', 'findings']);
    expect(report.version).toBe(JSON_REPORT_VERSION);
    expect(JSON_REPORT_VERSION).toBe(1);
  });

  it('counts findings by severity in the summary', () => {
    const report = toJsonReport([finding(), finding({ severity: 'low' }), finding({ severity: 'low' })]);
    expect(report.summary).toEqual({ high: 1, medium: 0, low: 2, info: 0 });
  });

  it('is pretty-printed, ends with a newline and is stable between runs', () => {
    const out = formatJson([finding()]);
    expect(out.endsWith('}\n')).toBe(true);
    expect(out).toContain('\n  "version": 1');
    expect(formatJson([finding()])).toBe(out);
  });

  it('keeps the fields of a finding in a fixed order and leaves out an absent column', () => {
    const [plain] = toJsonReport([finding()]).findings;
    expect(Object.keys(plain!)).toEqual(['ruleId', 'severity', 'message', 'file', 'line', 'fix']);
    const [withColumn] = toJsonReport([finding({ column: 3 })]).findings;
    expect(Object.keys(withColumn!)).toEqual(['ruleId', 'severity', 'message', 'file', 'line', 'column', 'fix']);
    expect(withColumn!.column).toBe(3);
  });

  it('does not add fields a rule put on a finding that are not part of the report', () => {
    const extra = { ...finding(), secret: 'leak' } as Finding;
    expect(JSON.stringify(toJsonReport([extra]))).not.toContain('leak');
  });

  describe('completeness', () => {
    it('is complete with no warnings by default', () => {
      const report = toJsonReport([]);
      expect(report.complete).toBe(true);
      expect(report.warnings).toEqual([]);
    });

    it('reports complete: false when a check could not run', () => {
      expect(toJsonReport([], { incomplete: true }).complete).toBe(false);
    });

    it('reports complete: true when told so explicitly', () => {
      expect(toJsonReport([], { incomplete: false }).complete).toBe(true);
    });

    it('includes the warnings, in order', () => {
      expect(toJsonReport([], { warnings: ['first', 'second'] }).warnings).toEqual(['first', 'second']);
    });

    it('can be incomplete and still report findings', () => {
      const report = toJsonReport([finding()], { incomplete: true, warnings: ['registry down'] });
      expect(report.complete).toBe(false);
      expect(report.findings).toHaveLength(1);
    });

    it('masks secrets and escapes control characters in warnings', () => {
      const report = toJsonReport([], { warnings: [`${FAKE.__FAKE_GITHUB_TOKEN__} failed ${ESC}[2J`] });
      const text = JSON.stringify(report);
      expect(text).not.toContain(FAKE.__FAKE_GITHUB_TOKEN__);
      expect(report.warnings[0]).toContain('ghp_...');
      expect(report.warnings[0]).not.toContain(ESC);
    });
  });

  it('masks secrets in messages, fixes and file names', () => {
    const text = formatJson([finding({ message: `x ${FAKE.__FAKE_SLACK__}`, fix: FAKE.__FAKE_AWS_ID__, file: `${FAKE.__FAKE_GITHUB_TOKEN__}.json` })]);
    for (const secret of [FAKE.__FAKE_SLACK__, FAKE.__FAKE_AWS_ID__, FAKE.__FAKE_GITHUB_TOKEN__]) expect(text).not.toContain(secret);
  });
});

describe('secret masking', () => {
  it('maskSecret keeps four characters then "..."', () => {
    expect(maskSecret('abcdefghij')).toBe('abcd...');
    expect(maskSecret('ab')).toBe('ab...');
    expect(maskSecret('')).toBe('...');
  });

  it.each([
    ['an AWS access key ID', FAKE.__FAKE_AWS_ID__, 'AKIA...'],
    ['a temporary AWS key ID', `ASIA${'Q7Z3'.repeat(4)}`, 'ASIA...'],
    ['a Stripe live secret key', FAKE.__FAKE_STRIPE_LIVE__, 'sk_l...'],
    ['a Stripe live restricted key', `rk_live_${'0fAk3'.repeat(5)}`, 'rk_l...'],
    ['a GitHub personal access token', FAKE.__FAKE_GITHUB_TOKEN__, 'ghp_...'],
    ['a GitHub OAuth token', `gho_${'f4K3'.repeat(9)}`, 'gho_...'],
    ['a GitHub fine-grained token', `github_pat_${'f4K3'.repeat(9)}`, 'gith...'],
    ['a Slack token', FAKE.__FAKE_SLACK__, 'xoxb...'],
  ])('redactSecrets masks %s', (_label, secret, masked) => {
    const out = redactSecrets(`before ${secret} after`);
    expect(out).toBe(`before ${masked} after`);
  });

  it('redactSecrets replaces a whole PEM block, not just its first line', () => {
    const out = redactSecrets(`key:\n${FAKE.__FAKE_PEM__}\nend`);
    expect(out).not.toContain('bm90LWEtcmVhbC1rZXk=');
    expect(out).toContain('----...');
  });

  it('redactSecrets masks every secret in a text', () => {
    const out = redactSecrets(`${FAKE.__FAKE_AWS_ID__} and ${FAKE.__FAKE_GITHUB_TOKEN__}`);
    expect(out).toBe('AKIA... and ghp_...');
  });

  it('redactSecrets leaves ordinary text and short lookalikes alone', () => {
    const text = 'ghp_short, AKIA123, sk_live_x, plain words';
    expect(redactSecrets(text)).toBe(text);
  });

  it('redactFinding masks message, fix and file and keeps the other fields', () => {
    const f = redactFinding(finding({ message: FAKE.__FAKE_AWS_ID__, fix: FAKE.__FAKE_AWS_ID__, file: FAKE.__FAKE_AWS_ID__, column: 4 }));
    expect([f.message, f.fix, f.file]).toEqual(['AKIA...', 'AKIA...', 'AKIA...']);
    expect(f).toMatchObject({ ruleId: 'RULES-001', severity: 'high', line: 14, column: 4 });
  });
});

describe('escapeUnsafe', () => {
  it('leaves printable text, tabs and non-ASCII letters alone', () => {
    expect(escapeUnsafe('plain\ttext café 日本語 😀')).toBe('plain\ttext café 日本語 😀');
  });

  it.each([
    ['NUL', '\u0000', '\\u0000'],
    ['bell', '\u0007', '\\u0007'],
    ['newline', '\n', '\\u000A'],
    ['carriage return', '\r', '\\u000D'],
    ['escape', '\u001b', '\\u001B'],
    ['DEL', '\u007f', '\\u007F'],
    ['C1 control', '\u009b', '\\u009B'],
    ['zero-width space', '​', '\\u200B'],
    ['right-to-left override', '‮', '\\u202E'],
    ['bidi isolate', '⁦', '\\u2066'],
    ['word joiner', '⁠', '\\u2060'],
    ['byte order mark', '﻿', '\\uFEFF'],
    ['soft hyphen', '­', '\\u00AD'],
  ])('escapes %s', (_name, input, escaped) => {
    expect(escapeUnsafe(`a${input}b`)).toBe(`a${escaped}b`);
  });

  it('escapes Unicode tag characters outside the BMP with braces', () => {
    expect(escapeUnsafe('a\u{E0041}b')).toBe('a\\u{E0041}b');
  });

  it('is idempotent on already-escaped text', () => {
    const once = escapeUnsafe('a‮b');
    expect(escapeUnsafe(once)).toBe(once);
  });
});
