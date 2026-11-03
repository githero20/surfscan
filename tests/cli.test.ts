import { describe, expect, it } from 'vitest';
import { fixture, runCli } from './helpers.js';

describe('cli', () => {
  it('exits 0 when there are no findings', async () => {
    const r = await runCli(['rules', fixture('RULES-001', 'clean')]);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe('No findings\n');
  });

  it('exits 1 on a high finding and prints the text report', async () => {
    const r = await runCli(['rules', fixture('RULES-003', 'bad')]);
    expect(r.code).toBe(1);
    expect(r.stdout).toMatch(/^\.cursorrules:2 {3}HIGH {4}RULES-003 {2}Download piped into a shell/m);
    expect(r.stdout).toContain('  Fix: download the script');
    expect(r.stdout.trimEnd().split('\n').at(-1)).toBe('4 findings (4 high)');
  });

  it('resolves the path argument against the working directory', async () => {
    const r = await runCli(['rules', 'RULES-003/bad']);
    expect(r.code).toBe(1);
  });

  describe('--fail-on', () => {
    it('ignores medium findings by default', async () => {
      const r = await runCli(['rules', fixture('RULES-006', 'bad')]);
      expect(r.code).toBe(0);
      expect(r.stdout).toContain('2 findings (2 medium)');
    });

    it('fails on medium findings with --fail-on medium', async () => {
      const r = await runCli(['rules', fixture('RULES-006', 'bad'), '--fail-on', 'medium']);
      expect(r.code).toBe(1);
    });

    it('rejects an unknown severity with exit 2', async () => {
      const r = await runCli(['rules', '--fail-on', 'critical']);
      expect(r.code).toBe(2);
      expect(r.stderr).toContain('Allowed choices');
    });
  });

  describe('--format json', () => {
    it('prints a versioned report with a summary', async () => {
      const r = await runCli(['rules', fixture('RULES-008', 'bad'), '--format', 'json']);
      expect(r.code).toBe(0);
      const report = JSON.parse(r.stdout);
      expect(report.version).toBe(1);
      expect(report.summary).toEqual({ high: 0, medium: 2, low: 0, info: 0 });
      expect(report.findings[0]).toMatchObject({
        ruleId: 'RULES-008',
        severity: 'medium',
        file: 'AGENTS.md',
        line: 3,
      });
      expect(Object.keys(report.findings[0])).toEqual(['ruleId', 'severity', 'message', 'file', 'line', 'column', 'fix']);
    });

    it('prints an empty report when clean', async () => {
      const r = await runCli(['rules', fixture('RULES-008', 'clean'), '--format', 'json']);
      expect(JSON.parse(r.stdout)).toEqual({ version: 1, summary: { high: 0, medium: 0, low: 0, info: 0 }, findings: [] });
    });
  });

  describe('config', () => {
    it('skips rules listed in "ignore"', async () => {
      const r = await runCli(['rules', fixture('cli', 'ignore-rule')]);
      expect(r.code).toBe(0);
      expect(r.stdout).not.toContain('RULES-003');
    });

    it('skips files matched by "ignorePaths"', async () => {
      const r = await runCli(['rules', fixture('cli', 'ignore-path')]);
      expect(r.code).toBe(0);
      expect(r.stdout).toBe('No findings\n');
    });

    it('--config replaces the default config file and must exist', async () => {
      const r = await runCli(['rules', fixture('cli', 'ignore-path'), '--config', fixture('cli', 'ignore-rule', 'surfscan.json')]);
      expect(r.code).toBe(0);
      const r2 = await runCli(['rules', fixture('cli', 'ignore-path'), '--config', fixture('RULES-001', 'clean', 'missing.json')]);
      expect(r2.code).toBe(2);
      expect(r2.stderr).toContain('config file not found');
    });

    it('rejects unknown keys with exit 2', async () => {
      const r = await runCli(['rules', fixture('cli', 'bad-config')]);
      expect(r.code).toBe(2);
      expect(r.stderr).toContain('unknown key "ignores"');
    });
  });

  describe('errors', () => {
    it('exits 2 for a missing path', async () => {
      const r = await runCli(['rules', fixture('does-not-exist')]);
      expect(r.code).toBe(2);
      expect(r.stderr).toContain('path not found');
    });

    it('exits 2 for an unknown command', async () => {
      expect((await runCli(['nope'])).code).toBe(2);
    });

    it('exits 2 with no command', async () => {
      expect((await runCli([])).code).toBe(2);
    });

    it('exits 0 for --help and --version', async () => {
      expect((await runCli(['--help'])).code).toBe(0);
      expect((await runCli(['--version'])).code).toBe(0);
    });

    it('exits 2 for commands not built yet', async () => {
      const r = await runCli(['keys']);
      expect(r.code).toBe(2);
      expect(r.stderr).toContain('not available');
    });
  });

  describe('secret masking', () => {
    const key = 'AKIAIOSFODNN7EXAMPLE';

    it('masks secrets in text output', async () => {
      const r = await runCli(['rules', fixture('cli', 'mask')]);
      expect(r.code).toBe(1);
      expect(r.stdout).toContain('RULES-003');
      expect(r.stdout).not.toContain(key);
      expect(r.stdout).toContain('AKIA...');
    });

    it('masks secrets in JSON output', async () => {
      const r = await runCli(['rules', fixture('cli', 'mask'), '--format', 'json']);
      expect(r.stdout).not.toContain(key);
      expect(r.stdout).toContain('AKIA...');
    });
  });
});
