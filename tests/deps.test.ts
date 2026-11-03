import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../src/core/config.js';
import { runScanner } from '../src/core/runner.js';
import { depsScanner } from '../src/scanners/deps/index.js';
import { lockedVersion } from '../src/scanners/deps/lockfile.js';
import type { FetchLike } from '../src/scanners/deps/registry.js';
import { typosquatTarget } from '../src/scanners/deps/typosquat.js';
import { scanFixture } from './helpers.js';

const OLD = '2015-01-01T00:00:00.000Z';
const daysAgo = (n: number): string => new Date(Date.now() - n * 86_400_000).toISOString();

type Doc = Record<string, unknown>;

/** A registry document for one version, old and unremarkable unless overridden. */
function doc(version = '1.0.0', versionFields: Doc = {}, created = OLD): Doc {
  return {
    'dist-tags': { latest: version },
    time: { created, [version]: created },
    versions: { [version]: versionFields },
  };
}

interface MockOptions {
  downloads?: Record<string, number>;
}

function mockRegistry(docs: Record<string, Doc>, { downloads = {} }: MockOptions = {}) {
  const urls: string[] = [];
  const fetcher: FetchLike = async (url, init) => {
    urls.push(url);
    expect(init).not.toHaveProperty('body');
    const name = decodeURIComponent(url.slice(url.lastIndexOf('/') + 1));
    if (url.startsWith('https://downloads.test/')) {
      return { ok: true, status: 200, json: async () => ({ downloads: downloads[name] ?? 0 }) };
    }
    const body = docs[name];
    return body
      ? { ok: true, status: 200, json: async () => body }
      : { ok: false, status: 404, json: async () => ({}) };
  };
  return { urls, options: { fetch: fetcher, registryUrl: 'https://registry.test', downloadsUrl: 'https://downloads.test' } };
}

function memory(files: Record<string, string>) {
  return { list: async () => Object.keys(files), read: async (p: string) => files[p] };
}

async function scanMemory(files: Record<string, string>, options: Record<string, unknown>) {
  return runScanner(depsScanner, { provider: memory(files), config: DEFAULT_CONFIG, options });
}

const scan = (id: string, variant: 'bad' | 'clean', docs: Record<string, Doc>, opts?: MockOptions) =>
  scanFixture(depsScanner, id, variant, mockRegistry(docs, opts).options);

describe('deps scanner', () => {
  it('lists rules ordered high to low', () => {
    const rank = { high: 3, medium: 2, low: 1, info: 0 };
    const ranks = depsScanner.rules.map((r) => rank[r.severity]);
    expect(ranks).toEqual([...ranks].sort((a, b) => b - a));
  });

  describe('DEPS-001', () => {
    it('DEPS-001 flags missing packages, unpublished packages and unpublished versions', async () => {
      const findings = await scan('DEPS-001', 'bad', {
        'gone-package': { time: { created: OLD, unpublished: { time: OLD } } },
        'real-package': doc('1.0.0'),
      });
      expect(findings.map((f) => f.message)).toEqual([
        '"made-up-package" does not exist on the npm registry',
        '"gone-package" was unpublished from the npm registry',
        '"real-package" has no published version 9.9.9',
      ]);
      expect(findings.map((f) => f.line)).toEqual([3, 4, 5]);
    });

    it('DEPS-001 skips workspace, local and URL dependencies', async () => {
      expect(await scan('DEPS-001', 'clean', { 'real-package': doc('1.0.0') })).toEqual([]);
    });
  });

  describe('DEPS-002', () => {
    it('DEPS-002 flags misspellings and separator swaps', async () => {
      const findings = await scan('DEPS-002', 'bad', {});
      expect(findings.map((f) => f.message)).toEqual([
        '"lodahs" is very close to the popular package "lodash"',
        '"crossenv" is very close to the popular package "cross-env"',
      ]);
    });

    it('DEPS-002 accepts popular packages and unrelated names', async () => {
      expect(await scan('DEPS-002', 'clean', {})).toEqual([]);
    });

    it('DEPS-002 leaves out widely downloaded packages when online', async () => {
      const findings = await scan('DEPS-002', 'bad', {}, { downloads: { lodahs: 50_000 } });
      expect(findings.map((f) => f.message)).toEqual(['"crossenv" is very close to the popular package "cross-env"']);
    });

    it('DEPS-002 compares names', () => {
      expect(typosquatTarget('expres')).toBe('express');
      expect(typosquatTarget('@babel/cores')).toBe('@babel/core');
      expect(typosquatTarget('cross_env')).toBe('cross-env');
      expect(typosquatTarget('REACT')).toBeUndefined();
      expect(typosquatTarget('preact')).toBeUndefined();
      expect(typosquatTarget('wholly-unrelated')).toBeUndefined();
    });
  });

  describe('DEPS-003', () => {
    const versions = (previous: string[], newest: string[]) => ({
      'dist-tags': { latest: '2.0.0' },
      time: { created: OLD, '1.0.0': OLD, '2.0.0': daysAgo(90) },
      versions: {
        '1.0.0': { maintainers: previous.map((name) => ({ name, email: `${name}@example.com` })) },
        '2.0.0': { maintainers: newest.map((name) => ({ name, email: `${name}@example.com` })) },
      },
    });

    it('DEPS-003 flags a new maintainer in the latest release, without printing emails', async () => {
      const findings = await scan('DEPS-003', 'bad', { 'some-package': versions(['alice'], ['alice', 'mallory']) });
      expect(findings).toHaveLength(1);
      expect(findings[0]!.message).toContain('mallory');
      expect(findings[0]!.message).not.toContain('@example.com');
    });

    it('DEPS-003 accepts unchanged maintainers and a removal', async () => {
      expect(await scan('DEPS-003', 'clean', { 'some-package': versions(['alice', 'bob'], ['alice']) })).toEqual([]);
    });
  });

  describe('DEPS-004', () => {
    it('DEPS-004 flags a package younger than deps.minAgeDays', async () => {
      const findings = await scan('DEPS-004', 'bad', { 'brand-new': doc('1.0.0', {}, daysAgo(3)) });
      expect(findings[0]!.message).toBe('"brand-new" was first published 3 day(s) ago (minimum 30)');
    });

    it('DEPS-004 accepts an older package', async () => {
      expect(await scan('DEPS-004', 'clean', { 'old-package': doc() })).toEqual([]);
    });
  });

  describe('DEPS-005', () => {
    it('DEPS-005 flags install hooks', async () => {
      const findings = await scan('DEPS-005', 'bad', {
        'has-hook': doc('1.0.0', { scripts: { postinstall: 'node steal.js' } }),
      });
      expect(findings[0]!.message).toBe('"has-hook@1.0.0" runs a postinstall script: node steal.js');
    });

    it('DEPS-005 ignores other scripts', async () => {
      expect(await scan('DEPS-005', 'clean', { 'no-hook': doc('1.0.0', { scripts: { test: 'vitest' } }) })).toEqual([]);
    });
  });

  describe('DEPS-006', () => {
    const docs = { 'any-version': doc(), 'tag-version': doc(), 'ranged-version': doc() };

    it('DEPS-006 flags * and latest', async () => {
      const findings = await scan('DEPS-006', 'bad', docs);
      expect(findings.map((f) => f.message)).toEqual([
        '"any-version" accepts any version ("*")',
        '"tag-version" accepts any version ("latest")',
      ]);
    });

    it('DEPS-006 accepts pinned versions and ranges', async () => {
      expect(await scan('DEPS-006', 'clean', docs)).toEqual([]);
    });
  });

  describe('DEPS-007', () => {
    it('DEPS-007 flags a deprecated version', async () => {
      const findings = await scan('DEPS-007', 'bad', { 'old-tool': doc('1.0.0', { deprecated: 'use new-tool' }) });
      expect(findings[0]!.message).toBe('"old-tool@1.0.0" is deprecated: use new-tool');
    });

    it('DEPS-007 accepts a maintained package', async () => {
      expect(await scan('DEPS-007', 'clean', { 'old-tool': doc() })).toEqual([]);
    });
  });

  describe('registry use', () => {
    const manifest = (deps: Record<string, string>) => JSON.stringify({ dependencies: deps });

    it('looks up each package once and encodes scoped names', async () => {
      const { urls, options } = mockRegistry({ '@acme/lib': doc() });
      await scanMemory(
        {
          'package.json': manifest({ '@acme/lib': '^1.0.0' }),
          'apps/web/package.json': manifest({ '@acme/lib': '^1.0.0' }),
        },
        options,
      );
      expect(urls).toEqual(['https://registry.test/@acme%2flib']);
    });

    it('checks the real package behind an npm alias', async () => {
      const { urls, options } = mockRegistry({ real: doc() });
      await scanMemory({ 'package.json': manifest({ alias: 'npm:real@1.0.0' }) }, options);
      expect(urls).toEqual(['https://registry.test/real']);
    });

    it('fails soft with one clear warning when the registry is unreachable', async () => {
      const result = await scanMemory(
        { 'package.json': manifest({ one: '^1.0.0', two: '^1.0.0' }) },
        {
          fetch: async () => {
            throw new Error('getaddrinfo ENOTFOUND');
          },
        },
      );
      expect(result.findings).toEqual([]);
      expect(result.warnings).toEqual([expect.stringContaining('could not check 2 of 2 package(s)')]);
      expect(result.warnings[0]).toContain('ENOTFOUND');
    });

    it('never contacts the registry when offline, and says what it skipped', async () => {
      const { urls, options } = mockRegistry({});
      const result = await scanMemory(
        { 'package.json': manifest({ lodahs: '*' }) },
        { ...options, offline: true },
      );
      expect(urls).toEqual([]);
      expect(result.findings.map((f) => f.ruleId)).toEqual(['DEPS-002', 'DEPS-006']);
      expect(result.warnings[0]).toContain('offline');
    });

    it('does not send private packages to the public registry', async () => {
      const { urls, options } = mockRegistry({ open: doc() });
      const result = await scanMemory(
        {
          'package.json': manifest({ '@acme/secret': '^1.0.0', open: '^1.0.0' }),
          '.npmrc': '@acme:registry=https://npm.acme.test/\n',
        },
        options,
      );
      expect(urls).toEqual(['https://registry.test/open']);
      expect(result.warnings[0]).toContain('private registry');
    });

    it('rejects names that are not valid package names', async () => {
      const { urls, options } = mockRegistry({});
      const result = await scanMemory({ 'package.json': manifest({ '../../evil': '^1.0.0' }) }, options);
      expect(urls).toEqual([]);
      expect(result.warnings[0]).toContain('invalid package name');
    });

    it('warns and continues on an invalid manifest', async () => {
      const { options } = mockRegistry({});
      const result = await scanMemory({ 'package.json': '{ nope' }, options);
      expect(result.warnings[0]).toContain('could not parse package.json');
    });
  });

  describe('lock files', () => {
    const packageLock = JSON.stringify({ packages: { 'node_modules/thing': { version: '1.2.3' }, 'apps/web/node_modules/thing': { version: '2.0.0' } } });
    const pnpm = "importers:\n  .:\n    dependencies:\n      thing:\n        specifier: ^1.0.0\n        version: 1.2.3(react@18.0.0)\n";
    const pnpmPackages = "packages:\n  /thing@1.2.3:\n    resolution: {integrity: x}\n";
    const yarnClassic = 'thing@^1.0.0:\n  version "1.2.3"\n  resolved "https://example.test"\n';
    const yarnBerry = '"thing@npm:^1.0.0":\n  version: 1.2.3\n';

    it('reads the resolved version from each format', () => {
      expect(lockedVersion('package-lock.json', packageLock, 'thing', '')).toBe('1.2.3');
      expect(lockedVersion('package-lock.json', packageLock, 'thing', 'apps/web/')).toBe('2.0.0');
      expect(lockedVersion('pnpm-lock.yaml', pnpm, 'thing', '')).toBe('1.2.3');
      expect(lockedVersion('pnpm-lock.yaml', pnpmPackages, 'thing', '')).toBe('1.2.3');
      expect(lockedVersion('yarn.lock', yarnClassic, 'thing', '')).toBe('1.2.3');
      expect(lockedVersion('yarn.lock', yarnBerry, 'thing', '')).toBe('1.2.3');
      expect(lockedVersion('yarn.lock', yarnClassic, 'other', '')).toBeUndefined();
    });

    it('DEPS-005 checks the locked version rather than latest', async () => {
      const { options } = mockRegistry({
        thing: {
          'dist-tags': { latest: '2.0.0' },
          time: { created: OLD, '1.2.3': OLD, '2.0.0': OLD },
          versions: { '1.2.3': { scripts: { install: 'node x.js' } }, '2.0.0': {} },
        },
      });
      const result = await scanMemory(
        { 'package.json': JSON.stringify({ dependencies: { thing: '^1.0.0' } }), 'yarn.lock': 'thing@^1.0.0:\n  version "1.2.3"\n' },
        options,
      );
      expect(result.findings.map((f) => f.message)).toEqual(['"thing@1.2.3" runs a install script: node x.js']);
    });

    it('warns once on a corrupt package-lock', async () => {
      const { options } = mockRegistry({ one: doc(), two: doc() });
      const result = await scanMemory(
        { 'package.json': JSON.stringify({ dependencies: { one: '^1.0.0', two: '^1.0.0' } }), 'package-lock.json': '{ nope' },
        options,
      );
      expect(result.warnings.filter((w) => w.includes('could not parse lock file'))).toHaveLength(1);
    });
  });
});
