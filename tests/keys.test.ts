import { describe, expect, it } from 'vitest';
import { formatJson } from '../src/core/report/json.js';
import { formatText } from '../src/core/report/text.js';
import { keysScanner } from '../src/scanners/keys/index.js';
import { parseGitignore } from '../src/scanners/keys/gitignore.js';
import { FAKE, scanFixture } from './helpers.js';

const scan = (id: string, variant: 'bad' | 'clean') => scanFixture(keysScanner, id, variant);
const where = (findings: { file: string; line: number }[]) => findings.map((f) => `${f.file}:${f.line}`);

describe('keys scanner', () => {
  it('lists rules ordered high to low', () => {
    const rank = { high: 3, medium: 2, low: 1, info: 0 };
    const ranks = keysScanner.rules.map((r) => rank[r.severity]);
    expect(ranks).toEqual([...ranks].sort((a, b) => b - a));
  });

  describe('KEYS-001', () => {
    it('KEYS-001 flags live key formats and production credentials', async () => {
      const findings = await scan('KEYS-001', 'bad');
      expect(where(findings)).toEqual([
        '.env:2',
        '.env:3',
        '.mcp.json:7',
        'config/app.json:3',
        'config/app.json:5',
        'deploy/config.yml:3',
        'deploy/config.yml:4',
        'deploy/deploy.key:1',
      ]);
    });

    it('KEYS-001 ignores example keys, test keys, placeholders and PRODUCT-like names', async () => {
      expect(await scan('KEYS-001', 'clean')).toEqual([]);
    });

    it('KEYS-001 never prints a full key in text or JSON output', async () => {
      const findings = await scan('KEYS-001', 'bad');
      const text = formatText(findings, { color: false });
      const json = formatJson(findings);
      for (const value of [FAKE.__FAKE_AWS_ID__!, FAKE.__FAKE_GITHUB_TOKEN__!, FAKE.__FAKE_STRIPE_LIVE__!, FAKE.__FAKE_SLACK__!]) {
        expect(text).not.toContain(value);
        expect(json).not.toContain(value);
      }
      for (const value of ['a9f3k2l1m0n8b7v6', 's3cr3tPassw0rd!', 'hunter22', 'bm90LWEtcmVhbC1rZXk=']) {
        expect(text).not.toContain(value);
        expect(json).not.toContain(value);
      }
      expect(text).toContain('AKIA...');
      expect(text).toContain('PROD_API_KEY=a9f3...');
    });
  });

  describe('KEYS-002', () => {
    it('KEYS-002 flags env files with secrets that .gitignore does not cover', async () => {
      const findings = await scan('KEYS-002', 'bad');
      expect(where(findings)).toEqual(['.env.local:2', 'apps/web/.env:1']);
    });

    it('KEYS-002 accepts ignored files, templates and files without secrets', async () => {
      expect(await scan('KEYS-002', 'clean')).toEqual([]);
    });

    it('KEYS-002 gitignore patterns follow git semantics', () => {
      const match = (pattern: string, path: string) => parseGitignore(pattern, '').some((p) => p.regex.test(path));
      expect(match('.env', 'a/b/.env')).toBe(true);
      expect(match('/.env', 'a/.env')).toBe(false);
      expect(match('.env*', '.env.production')).toBe(true);
      expect(match('config/**/secrets.env', 'config/x/y/secrets.env')).toBe(true);
      expect(match('*.env', 'deploy/prod.env')).toBe(true);
    });
  });

  describe('KEYS-003', () => {
    it('KEYS-003 flags wildcard statements and admin roles', async () => {
      const findings = await scan('KEYS-003', 'bad');
      expect(where(findings)).toEqual(['iam/agent-policy.json:6', 'infra/gcp-iam.yaml:4', 'infra/main.tf:3', 'infra/stack.yaml:8']);
      expect(findings.every((f) => f.severity === 'medium')).toBe(true);
    });

    it('KEYS-003 ignores scoped policies, deny statements and read-only roles', async () => {
      expect(await scan('KEYS-003', 'clean')).toEqual([]);
    });
  });
});
