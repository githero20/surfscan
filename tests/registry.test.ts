import { describe, expect, it } from 'vitest';
import {
  DEFAULT_DOWNLOADS_URL,
  DEFAULT_REGISTRY_URL,
  fetchPackument,
  fetchWeeklyDownloads,
  mapLimit,
  toPackument,
  type FetchLike,
} from '../src/scanners/deps/registry.js';
import { typosquatTarget } from '../src/scanners/deps/typosquat.js';
import { lockedVersion } from '../src/scanners/deps/lockfile.js';

const respond = (status: number, body: unknown = {}): ReturnType<FetchLike> =>
  Promise.resolve({ ok: status >= 200 && status < 300, status, json: async () => body });

describe('registry: toPackument', () => {
  it('keeps the latest tag, creation time and per-version scripts, maintainers and deprecation', () => {
    const p = toPackument({
      'dist-tags': { latest: '2.0.0', beta: '3.0.0-beta.1' },
      time: { created: '2020-01-01T00:00:00.000Z', '1.0.0': '2020-01-01T00:00:00.000Z', '2.0.0': '2021-01-01T00:00:00.000Z' },
      versions: {
        '1.0.0': { scripts: { postinstall: 'node x.js', test: 'vitest' }, maintainers: [{ name: 'ann' }], deprecated: 'use 2.x' },
        '2.0.0': { maintainers: [{ name: 'ann' }, { name: 'bob' }] },
      },
    });
    expect(p.latest).toBe('2.0.0');
    expect(p.created).toBe('2020-01-01T00:00:00.000Z');
    expect(p.unpublished).toBe(false);
    expect(p.versions['1.0.0']).toEqual({ scripts: { postinstall: 'node x.js', test: 'vitest' }, maintainers: ['ann'], deprecated: 'use 2.x' });
    expect(p.versions['2.0.0']).toEqual({ scripts: {}, maintainers: ['ann', 'bob'] });
    expect(p.times['2.0.0']).toBe('2021-01-01T00:00:00.000Z');
  });

  it('reads maintainer names from objects and from "name <email>" strings, dropping the email', () => {
    const p = toPackument({ versions: { '1.0.0': { maintainers: ['ann <ann@example.com>', { name: 'bob', email: 'b@example.com' }, 'cy'] } } });
    expect(p.versions['1.0.0']!.maintainers).toEqual(['ann', 'bob', 'cy']);
  });

  it('ignores maintainer entries it cannot read', () => {
    const p = toPackument({ versions: { '1.0.0': { maintainers: [1, null, {}, { name: 5 }, { name: 'ok' }] } } });
    expect(p.versions['1.0.0']!.maintainers).toEqual(['ok']);
  });

  it('marks a package as unpublished when the time field says so', () => {
    expect(toPackument({ time: { unpublished: { time: '2022-01-01' } }, versions: {} }).unpublished).toBe(true);
  });

  it('does not keep an empty deprecation message', () => {
    expect(toPackument({ versions: { '1.0.0': { deprecated: '' } } }).versions['1.0.0']).not.toHaveProperty('deprecated');
  });

  it('keeps only string script values', () => {
    const p = toPackument({ versions: { '1.0.0': { scripts: { install: 'x', broken: 5 } } } });
    expect(p.versions['1.0.0']!.scripts).toEqual({ install: 'x' });
  });

  it.each([[null], [undefined], ['text'], [42], [[]]])('returns an empty package for %j', (raw) => {
    expect(toPackument(raw)).toEqual({ latest: undefined, created: undefined, unpublished: false, versions: {}, times: {} });
  });

  it('copes with versions that are not objects', () => {
    expect(toPackument({ versions: { '1.0.0': null } }).versions['1.0.0']).toEqual({ scripts: {}, maintainers: [] });
  });
});

describe('registry: fetchPackument', () => {
  it('requests the package under the registry URL, asking for JSON, with a timeout signal', async () => {
    let seen: { url: string; init: Parameters<FetchLike>[1] } | undefined;
    const fetcher: FetchLike = (url, init) => ((seen = { url, init }), respond(200, {}));
    await fetchPackument(fetcher, 'https://registry.test', 'left-pad');
    expect(seen!.url).toBe('https://registry.test/left-pad');
    expect(seen!.init!.headers).toEqual({ accept: 'application/json' });
    expect(seen!.init!.signal).toBeInstanceOf(AbortSignal);
  });

  it('sends nothing but the package name: no body, no cookies, no auth', async () => {
    let init: Parameters<FetchLike>[1];
    await fetchPackument((_url, i) => ((init = i), respond(200)), 'https://registry.test', 'x');
    expect(Object.keys(init!).sort()).toEqual(['headers', 'signal']);
    expect(Object.keys(init!.headers!)).toEqual(['accept']);
  });

  it('encodes a scoped name as @scope%2fname', async () => {
    let url = '';
    await fetchPackument((u) => ((url = u), respond(200)), 'https://registry.test', '@babel/core');
    expect(url).toBe('https://registry.test/@babel%2fcore');
  });

  it('returns found with the parsed packument', async () => {
    const lookup = await fetchPackument(() => respond(200, { 'dist-tags': { latest: '1.0.0' } }), 'https://r', 'x');
    expect(lookup).toMatchObject({ status: 'found', packument: { latest: '1.0.0' } });
  });

  it('returns missing for a 404', async () => {
    expect(await fetchPackument(() => respond(404), 'https://r', 'x')).toEqual({ status: 'missing' });
  });

  it.each([401, 403, 429, 500, 502, 503])('returns an error, not "missing", for HTTP %i', async (status) => {
    expect(await fetchPackument(() => respond(status), 'https://r', 'x')).toEqual({ status: 'error', message: `HTTP ${status}` });
  });

  it('returns an error carrying the message when the request throws', async () => {
    const lookup = await fetchPackument(() => Promise.reject(new Error('getaddrinfo ENOTFOUND registry.test')), 'https://r', 'x');
    expect(lookup).toEqual({ status: 'error', message: 'getaddrinfo ENOTFOUND registry.test' });
  });

  it('returns an error when the body is not JSON', async () => {
    const lookup = await fetchPackument(
      () => Promise.resolve({ ok: true, status: 200, json: async () => Promise.reject(new SyntaxError('Unexpected token <')) }),
      'https://r',
      'x',
    );
    expect(lookup).toEqual({ status: 'error', message: 'Unexpected token <' });
  });

  it('never throws', async () => {
    await expect(fetchPackument(() => { throw new Error('sync failure'); }, 'https://r', 'x')).resolves.toMatchObject({ status: 'error' });
  });

  it('uses the public npm registry and download API by default', () => {
    expect(DEFAULT_REGISTRY_URL).toBe('https://registry.npmjs.org');
    expect(DEFAULT_DOWNLOADS_URL).toBe('https://api.npmjs.org/downloads/point/last-week');
  });
});

describe('registry: fetchWeeklyDownloads', () => {
  it('returns the download count', async () => {
    expect(await fetchWeeklyDownloads(() => respond(200, { downloads: 12345 }), 'https://d', 'x')).toBe(12345);
  });

  it('requests the package under the downloads URL, encoding scoped names', async () => {
    let url = '';
    await fetchWeeklyDownloads((u) => ((url = u), respond(200, { downloads: 1 })), 'https://d', '@a/b');
    expect(url).toBe('https://d/@a%2fb');
  });

  it('returns undefined when the response is not OK', async () => {
    expect(await fetchWeeklyDownloads(() => respond(404), 'https://d', 'x')).toBeUndefined();
    expect(await fetchWeeklyDownloads(() => respond(500), 'https://d', 'x')).toBeUndefined();
  });

  it('returns undefined when the body has no numeric downloads field', async () => {
    expect(await fetchWeeklyDownloads(() => respond(200, { downloads: '5' }), 'https://d', 'x')).toBeUndefined();
    expect(await fetchWeeklyDownloads(() => respond(200, {}), 'https://d', 'x')).toBeUndefined();
    expect(await fetchWeeklyDownloads(() => respond(200, null), 'https://d', 'x')).toBeUndefined();
  });

  it('returns undefined when the request fails', async () => {
    expect(await fetchWeeklyDownloads(() => Promise.reject(new Error('down')), 'https://d', 'x')).toBeUndefined();
  });
});

describe('registry: mapLimit', () => {
  it('returns results in the order of the input, not the order they finished', async () => {
    const out = await mapLimit([30, 5, 15], async (ms) => {
      await new Promise((r) => setTimeout(r, ms));
      return ms;
    });
    expect(out).toEqual([30, 5, 15]);
  });

  it('never runs more than the limit at once', async () => {
    let running = 0;
    let peak = 0;
    await mapLimit(Array.from({ length: 20 }, (_, i) => i), async () => {
      running++;
      peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, 5));
      running--;
    }, 3);
    expect(peak).toBe(3);
  });

  it('defaults to eight at once', async () => {
    let running = 0;
    let peak = 0;
    await mapLimit(Array.from({ length: 40 }, (_, i) => i), async () => {
      running++;
      peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, 5));
      running--;
    });
    expect(peak).toBe(8);
  });

  it('processes every item exactly once', async () => {
    const seen: number[] = [];
    await mapLimit([1, 2, 3, 4, 5], async (n) => void seen.push(n), 2);
    expect(seen.sort()).toEqual([1, 2, 3, 4, 5]);
  });

  it('handles an empty list and a limit larger than the list', async () => {
    expect(await mapLimit([], async (x) => x)).toEqual([]);
    expect(await mapLimit([1, 2], async (x) => x * 2, 50)).toEqual([2, 4]);
  });
});

describe('typosquatting', () => {
  it.each([
    ['expres', 'express'], // dropped letter
    ['expresss', 'express'], // extra letter
    ['expreess', 'express'], // doubled letter
    ['exprses', 'express'], // swapped neighbours
    ['axois', 'axios'], // transposition
    ['cross_env', 'cross-env'], // separator swap
    ['crossenv', 'cross-env'], // separator removed
    ['cross.env', 'cross-env'],
    ['@babel/cores', '@babel/core'],
  ])('%s looks like %s', (name, target) => {
    expect(typosquatTarget(name)).toBe(target);
  });

  it.each(['express', 'axios', 'react', 'lodash', '@babel/core'])('%s is a popular package itself, not a squat', (name) => {
    expect(typosquatTarget(name)).toBeUndefined();
  });

  it('ignores case', () => {
    expect(typosquatTarget('EXPRES')).toBe('express');
    expect(typosquatTarget('REACT')).toBeUndefined();
  });

  it('does not flag unrelated names', () => {
    for (const name of ['wholly-unrelated', 'my-company-utils', 'zzzzzzzz']) expect(typosquatTarget(name)).toBeUndefined();
  });

  it('does not flag short names, where one edit changes too much', () => {
    expect(typosquatTarget('vue2')).toBeUndefined();
    expect(typosquatTarget('ra')).toBeUndefined();
  });

  it('does not flag a longer genuine package that merely contains a popular name', () => {
    expect(typosquatTarget('preact')).toBeUndefined();
    expect(typosquatTarget('express-session')).toBeUndefined();
  });
});

describe('lock file readers', () => {
  it('package-lock: finds a root dependency, and a workspace dependency by its prefix', () => {
    const lock = JSON.stringify({
      packages: {
        'node_modules/thing': { version: '1.0.0' },
        'apps/web/node_modules/thing': { version: '2.0.0' },
        'node_modules/@scope/pkg': { version: '3.1.4' },
      },
    });
    expect(lockedVersion('package-lock.json', lock, 'thing', '')).toBe('1.0.0');
    expect(lockedVersion('package-lock.json', lock, 'thing', 'apps/web/')).toBe('2.0.0');
    expect(lockedVersion('package-lock.json', lock, '@scope/pkg', '')).toBe('3.1.4');
  });

  it('package-lock: a workspace falls back to the root install when it has no copy of its own', () => {
    const lock = JSON.stringify({ packages: { 'node_modules/thing': { version: '1.0.0' } } });
    expect(lockedVersion('package-lock.json', lock, 'thing', 'apps/web/')).toBe('1.0.0');
  });

  it('package-lock: returns undefined for an absent package, a missing version or no packages map', () => {
    expect(lockedVersion('package-lock.json', '{"packages":{}}', 'thing', '')).toBeUndefined();
    expect(lockedVersion('package-lock.json', '{"packages":{"node_modules/thing":{}}}', 'thing', '')).toBeUndefined();
    expect(lockedVersion('package-lock.json', '{}', 'thing', '')).toBeUndefined();
    expect(lockedVersion('package-lock.json', 'null', 'thing', '')).toBeUndefined();
  });

  it('package-lock: throws on invalid JSON, so the caller can warn', () => {
    expect(() => lockedVersion('package-lock.json', '{ nope', 'thing', '')).toThrow();
  });

  it('package-lock: accepts a byte order mark', () => {
    expect(lockedVersion('package-lock.json', '﻿{"packages":{"node_modules/t":{"version":"1.0.0"}}}', 't', '')).toBe('1.0.0');
  });

  it('pnpm: reads importer entries, quoted names and the version before peer suffixes', () => {
    const lock = "importers:\n  .:\n    dependencies:\n      '@scope/pkg':\n        specifier: ^1.0.0\n        version: 1.5.0(react@18.0.0)\n";
    expect(lockedVersion('pnpm-lock.yaml', lock, '@scope/pkg', '')).toBe('1.5.0');
  });

  it('pnpm: reads the packages section, with and without the leading slash', () => {
    expect(lockedVersion('pnpm-lock.yaml', "packages:\n  /thing@1.2.3:\n    resolution: x\n", 'thing', '')).toBe('1.2.3');
    expect(lockedVersion('pnpm-lock.yaml', "packages:\n  thing@1.2.3:\n    resolution: x\n", 'thing', '')).toBe('1.2.3');
  });

  it('pnpm: does not mistake a package with a longer name for the one asked about', () => {
    expect(lockedVersion('pnpm-lock.yaml', "packages:\n  /thing-extra@9.9.9:\n    resolution: x\n", 'thing', '')).toBeUndefined();
  });

  it('pnpm: handles Windows line endings', () => {
    const lock = "importers:\r\n  .:\r\n    dependencies:\r\n      thing:\r\n        specifier: ^1.0.0\r\n        version: 1.2.3\r\n";
    expect(lockedVersion('pnpm-lock.yaml', lock, 'thing', '')).toBe('1.2.3');
  });

  it('yarn: reads classic and berry entries and treats dots in names literally', () => {
    expect(lockedVersion('yarn.lock', 'thing@^1.0.0:\n  version "1.2.3"\n', 'thing', '')).toBe('1.2.3');
    expect(lockedVersion('yarn.lock', '"thing@npm:^1.0.0":\n  version: 1.2.3\n', 'thing', '')).toBe('1.2.3');
    expect(lockedVersion('yarn.lock', 'thingXjs@^1.0.0:\n  version "9.9.9"\n', 'thing.js', '')).toBeUndefined();
  });

  it('yarn: reads a scoped package', () => {
    expect(lockedVersion('yarn.lock', '"@scope/pkg@^2.0.0":\n  version "2.3.4"\n', '@scope/pkg', '')).toBe('2.3.4');
  });
});
