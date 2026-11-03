import { describe, expect, it } from 'vitest';
import { approvalsScanner } from '../src/scanners/approvals/index.js';
import { destructiveMatch, isWildcardShell, patternToRegex } from '../src/scanners/approvals/destructive.js';
import { parseRule } from '../src/scanners/approvals/adapters/claude-code.js';
import { DEFAULT_CONFIG } from '../src/core/config.js';
import { runScanner } from '../src/core/runner.js';
import { scanFixture } from './helpers.js';

const scan = (id: string, variant: 'bad' | 'clean') => scanFixture(approvalsScanner, id, variant);
const where = (findings: { file: string; line: number }[]) => findings.map((f) => `${f.file}:${f.line}`);

describe('approvals scanner', () => {
  it('lists rules ordered high to low', () => {
    const rank = { high: 3, medium: 2, low: 1, info: 0 };
    const ranks = approvalsScanner.rules.map((r) => rank[r.severity]);
    expect(ranks).toEqual([...ranks].sort((a, b) => b - a));
  });

  describe('APPR-001', () => {
    it('APPR-001 flags bypassPermissions and auto modes and the skipped confirmation', async () => {
      const findings = await scan('APPR-001', 'bad');
      expect(where(findings)).toEqual([
        '.claude/settings.json:3',
        '.claude/settings.local.json:2',
        'packages/app/.claude/settings.json:3',
      ]);
      expect(findings[2]!.message).toContain('"auto"');
    });

    it('APPR-001 accepts plan mode and a disabled bypass mode', async () => {
      expect(await scan('APPR-001', 'clean')).toEqual([]);
    });
  });

  describe('APPR-002', () => {
    it('APPR-002 flags allow rules that cover destructive commands', async () => {
      const findings = await scan('APPR-002', 'bad');
      expect(findings.map((f) => f.line)).toEqual([5, 6, 7, 8, 9]);
      expect(findings[1]!.message).toContain('force push');
    });

    it('APPR-002 ignores safe rules and deny rules', async () => {
      expect(await scan('APPR-002', 'clean')).toEqual([]);
    });
  });

  describe('APPR-003', () => {
    it('APPR-003 flags rules that allow any shell command or any code', async () => {
      const findings = await scan('APPR-003', 'bad');
      expect(findings.map((f) => f.line)).toEqual([4, 5, 6, 7, 8, 9, 10, 11, 12]);
    });

    it('APPR-003 ignores scoped rules, fixed scripts, deny rules and unanchored globs', async () => {
      expect(await scan('APPR-003', 'clean')).toEqual([]);
    });
  });

  describe('APPR-004', () => {
    it('APPR-004 flags all-server approval and whole-server tool rules', async () => {
      const findings = await scan('APPR-004', 'bad');
      expect(findings.map((f) => f.line)).toEqual([2, 5, 6]);
    });

    it('APPR-004 accepts per-server approval and single-tool rules', async () => {
      expect(await scan('APPR-004', 'clean')).toEqual([]);
    });
  });

  describe('APPR-005', () => {
    it('APPR-005 flags acceptEdits mode', async () => {
      const findings = await scan('APPR-005', 'bad');
      expect(where(findings)).toEqual(['.claude/settings.json:3']);
      expect(findings[0]!.severity).toBe('medium');
    });

    it('APPR-005 accepts the default mode', async () => {
      expect(await scan('APPR-005', 'clean')).toEqual([]);
    });
  });

  it('warns and continues when a settings file is not valid JSON', async () => {
    const files: Record<string, string> = { '.claude/settings.json': '{ "permissions": ' };
    const result = await runScanner(approvalsScanner, {
      config: DEFAULT_CONFIG,
      provider: {
        list: async () => Object.keys(files),
        read: async (p) => files[p],
      },
    });
    expect(result.findings).toEqual([]);
    expect(result.warnings[0]).toContain('could not parse Claude Code settings');
  });

  describe('pattern matching', () => {
    it('follows the documented Bash wildcard rules', () => {
      expect(patternToRegex('ls *').test('ls')).toBe(true);
      expect(patternToRegex('ls *').test('lsof')).toBe(false);
      expect(patternToRegex('ls*').test('lsof')).toBe(true);
      expect(patternToRegex('ls:*').test('ls -la')).toBe(true);
      expect(patternToRegex('git * main').test('git push origin main')).toBe(true);
      expect(patternToRegex('npm run build').test('npm run build --watch')).toBe(false);
    });

    it('classifies wildcard and destructive rules', () => {
      expect(isWildcardShell(undefined)).toBe(true);
      expect(isWildcardShell('*')).toBe(true);
      expect(isWildcardShell('npm run *')).toBe(false);
      expect(destructiveMatch('git *')).toContain('force push');
      expect(destructiveMatch('kubectl delete pod *')).toBe('cloud resource deletion');
      expect(destructiveMatch('git log *')).toBeUndefined();
    });

    it('parses Claude Code rule syntax', () => {
      expect(parseRule('Bash(npm test)', 1)).toMatchObject({ kind: 'shell', command: 'npm test' });
      expect(parseRule('mcp__github__*', 1)).toMatchObject({ kind: 'mcp', mcpServer: 'github', mcpTool: undefined });
      expect(parseRule('mcp__github__get_issue', 1)).toMatchObject({ kind: 'mcp', mcpTool: 'get_issue' });
      expect(parseRule('mcp__*', 1)).toMatchObject({ kind: 'other' });
    });
  });
});
