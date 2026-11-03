import { describe, expect, it } from 'vitest';
import { ConfigError, parseConfig } from '../src/core/config.js';
import { formatText } from '../src/core/report/text.js';
import { formatJson } from '../src/core/report/json.js';
import { escapeUnsafe } from '../src/core/report/sanitize.js';
import { hasFailures, sortFindings } from '../src/core/runner.js';
import { maskSecret, redactSecrets } from '../src/core/secret-patterns.js';
import { LineIndex } from '../src/core/text.js';
import type { Finding } from '../src/core/types.js';

const f = (over: Partial<Finding>): Finding => ({
  ruleId: 'RULES-001',
  severity: 'high',
  message: 'm',
  file: 'CLAUDE.md',
  line: 1,
  fix: 'x',
  ...over,
});

describe('config', () => {
  it('applies defaults', () => {
    expect(parseConfig('{}')).toEqual({ ignore: [], ignorePaths: [], deps: { minAgeDays: 30 } });
  });

  it('reads all known keys', () => {
    const c = parseConfig('{"ignore":["RULES-006"],"ignorePaths":["docs/**"],"deps":{"minAgeDays":7}}');
    expect(c).toEqual({ ignore: ['RULES-006'], ignorePaths: ['docs/**'], deps: { minAgeDays: 7 } });
  });

  it.each([
    ['{"extra":1}', 'unknown key "extra"'],
    ['{"deps":{"maxAge":1}}', 'unknown key "deps.maxAge"'],
    ['{"ignore":"RULES-001"}', 'must be an array of strings'],
    ['{"ignore":["rules-1"]}', 'is not a rule ID'],
    ['{"deps":{"minAgeDays":-1}}', 'non-negative integer'],
    ['[]', 'must be a JSON object'],
    ['{', 'invalid JSON'],
  ])('rejects %s', (text, message) => {
    expect(() => parseConfig(text)).toThrow(ConfigError);
    expect(() => parseConfig(text)).toThrow(message);
  });
});

describe('runner', () => {
  it('sorts by severity, then file and line', () => {
    const sorted = sortFindings([
      f({ severity: 'low', file: 'a', line: 1 }),
      f({ severity: 'high', file: 'b', line: 9 }),
      f({ severity: 'high', file: 'b', line: 2 }),
      f({ severity: 'medium', file: 'a', line: 1 }),
    ]);
    expect(sorted.map((x) => `${x.severity}:${x.line}`)).toEqual(['high:2', 'high:9', 'medium:1', 'low:1']);
  });

  it('compares against the --fail-on threshold', () => {
    const findings = [f({ severity: 'medium' })];
    expect(hasFailures(findings, 'high')).toBe(false);
    expect(hasFailures(findings, 'medium')).toBe(true);
    expect(hasFailures(findings, 'info')).toBe(true);
    expect(hasFailures([], 'info')).toBe(false);
  });
});

describe('LineIndex', () => {
  it('maps offsets to 1-based lines and columns, including CRLF files', () => {
    const idx = new LineIndex('ab\r\ncd\nef');
    expect(idx.positionOf(0)).toEqual({ line: 1, column: 1 });
    expect(idx.positionOf(5)).toEqual({ line: 2, column: 2 });
    expect(idx.positionOf(7)).toEqual({ line: 3, column: 1 });
    expect(idx.lineText(1)).toBe('ab');
  });
});

describe('masking and sanitizing', () => {
  // Built at runtime so the repo does not contain token-shaped strings.
  const ghToken = `ghp_${'a1B2'.repeat(9)}`;

  it('masks to the first 4 characters', () => {
    expect(maskSecret('sk_live_abcdef')).toBe('sk_l...');
  });

  it('redacts known secret formats inside text', () => {
    expect(redactSecrets(`token=${ghToken} end`)).toBe('token=ghp_... end');
  });

  it('never prints a secret that a rule put in a message', () => {
    const findings = [f({ message: `found ${ghToken}`, fix: `rotate ${ghToken}` })];
    expect(formatText(findings, { color: false })).not.toContain(ghToken);
    expect(formatJson(findings)).not.toContain(ghToken);
  });

  it('escapes terminal control and bidi characters', () => {
    expect(escapeUnsafe('a\u001b[31mb‮c')).toBe('a\\u001B[31mb\\u202Ec');
    const out = formatText([f({ message: 'x\u001b[2Jy' })], { color: false });
    expect(out).not.toContain('\u001b');
  });

  it('formats the summary line', () => {
    const out = formatText([f({}), f({ severity: 'low', line: 2 })], { color: false });
    expect(out.trimEnd().split('\n').at(-1)).toBe('2 findings (1 high, 1 low)');
  });
});
