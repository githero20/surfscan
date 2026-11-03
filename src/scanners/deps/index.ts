import { listTargets } from '../../core/runner.js';
import { excerpt, stripBom } from '../../core/text.js';
import type { Finding, Rule, ScanContext, Scanner, SourceFile, SourceProvider, SurfscanConfig } from '../../core/types.js';
import { JsonLocator } from '../shared-json.js';
import { LOCK_FILE_NAMES, lockedVersion } from './lockfile.js';
import {
  DEFAULT_DOWNLOADS_URL,
  DEFAULT_REGISTRY_URL,
  fetchPackument,
  fetchWeeklyDownloads,
  mapLimit,
  type FetchLike,
  type Lookup,
  type Packument,
} from './registry.js';
import { typosquatTarget } from './typosquat.js';

export const DEPS_TARGETS = ['**/package.json', ...LOCK_FILE_NAMES.map((name) => `**/${name}`)];

export function findDepsTargets(provider: SourceProvider, config: SurfscanConfig): Promise<string[]> {
  return listTargets(provider, config, DEPS_TARGETS);
}

/** Options read from `ScanContext.options`. */
export interface DepsOptions {
  offline?: boolean;
  fetch?: FetchLike;
  registryUrl?: string;
  downloadsUrl?: string;
}

const SECTIONS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'];
const INSTALL_HOOKS = ['preinstall', 'install', 'postinstall'];
const NAME = /^(?:@[a-z0-9~-][a-z0-9._~-]*\/)?[a-z0-9~-][a-z0-9._~-]*$/i;
const NOT_FROM_REGISTRY = /^(?:workspace|file|link|portal|git|git\+\w+|https?|github|gitlab|bitbucket):|^[^@/\s]+\/[^/\s]+$|^\.{0,2}\//i;
const EXACT_VERSION = /^[=v]*(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.+-]+)?)$/;
const UNPINNED_SPEC = /^(?:\*|x|latest|)$/i;
/** A package this widely used is not a squat, even if its name is close to another. */
const ESTABLISHED_WEEKLY_DOWNLOADS = 10_000;
const DAY_MS = 24 * 60 * 60 * 1000;

interface DepRef {
  /** The name on the registry, which differs from the declared one for `npm:` aliases. */
  name: string;
  file: string;
  line: number;
  spec: string;
  /** An exact version the project requests, from the manifest or a lock file. */
  version?: string;
}

interface DepsData {
  refs: DepRef[];
  /** Absent in offline mode. */
  lookups?: Map<string, Lookup>;
  options: DepsOptions;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function dirOf(path: string): string {
  const at = path.lastIndexOf('/');
  return at === -1 ? '' : path.slice(0, at);
}

const joinPath = (dir: string, name: string): string => (dir ? `${dir}/${name}` : name);

/** The nearest lock files at or above a directory, read through to a version lookup. */
function lockLookup(files: Map<string, SourceFile>, dir: string, context: ScanContext): (name: string) => string | undefined {
  return (name) => {
    let current = dir;
    for (;;) {
      for (const lockName of LOCK_FILE_NAMES) {
        const lock = files.get(joinPath(current, lockName));
        if (!lock) continue;
        const prefix = current === dir ? '' : `${dir.slice(current.length).replace(/^\//, '')}/`;
        try {
          const version = lockedVersion(lockName, lock.content, name, prefix);
          if (version) return version;
        } catch (err) {
          context.warn(`${lock.path}: could not parse lock file (${(err as Error).message})`);
          files.delete(lock.path);
        }
      }
      if (current === '') return undefined;
      current = dirOf(current);
    }
  };
}

/** Registry URLs from an .npmrc: the default under `''`, and one per scope. */
function parseNpmrc(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(?:(@[^:=\s]+):)?registry\s*=\s*(\S+)/.exec(line);
    if (m) out.set(m[1] ?? '', m[2]!);
  }
  return out;
}

const PUBLIC_REGISTRY = /^https?:\/\/registry\.(?:npmjs\.org|yarnpkg\.com)\/?$/i;

function usesPrivateRegistry(name: string, npmrc: Map<string, string>): boolean {
  const scope = name.startsWith('@') ? name.slice(0, name.indexOf('/')) : '';
  const url = npmrc.get(scope) ?? npmrc.get('');
  return url !== undefined && !PUBLIC_REGISTRY.test(url);
}

/** The registry package and spec behind a declared dependency, or undefined for local and URL specs. */
function resolveSpec(declared: string, spec: string): { name: string; spec: string } | undefined {
  const alias = /^npm:((?:@[^/]+\/)?[^@]+)(?:@(.*))?$/.exec(spec);
  if (alias) return { name: alias[1]!, spec: alias[2] ?? '' };
  return NOT_FROM_REGISTRY.test(spec) ? undefined : { name: declared, spec };
}

async function collectRefs(context: ScanContext): Promise<DepRef[]> {
  const byPath = new Map(context.files.map((f) => [f.path, f]));
  const manifests: Array<{ file: SourceFile; data: Record<string, unknown> }> = [];
  for (const file of context.files) {
    if (!file.path.endsWith('package.json')) continue;
    try {
      const data: unknown = JSON.parse(stripBom(file.content));
      if (isObject(data)) manifests.push({ file, data });
    } catch (err) {
      context.warn(`${file.path}: could not parse package.json (${(err as Error).message})`);
    }
  }

  const workspaceNames = new Set(manifests.map((m) => m.data.name).filter((n): n is string => typeof n === 'string'));
  const rootNpmrc = await context.provider.read('.npmrc').catch(() => undefined);
  const refs: DepRef[] = [];
  const skippedPrivate = new Set<string>();

  for (const { file, data } of manifests) {
    const dir = dirOf(file.path);
    const localNpmrc = dir ? await context.provider.read(joinPath(dir, '.npmrc')).catch(() => undefined) : undefined;
    const npmrc = new Map([...parseNpmrc(rootNpmrc ?? ''), ...parseNpmrc(localNpmrc ?? '')]);
    const locked = lockLookup(byPath, dir, context);
    const loc = new JsonLocator(file.content);

    for (const section of SECTIONS) {
      const deps = data[section];
      if (!isObject(deps)) continue;
      const from = Math.max(0, loc.keyOffset(section));
      for (const [declared, rawSpec] of Object.entries(deps)) {
        if (typeof rawSpec !== 'string') continue;
        const resolved = resolveSpec(declared, rawSpec.trim());
        if (!resolved || workspaceNames.has(resolved.name)) continue;
        if (!NAME.test(resolved.name)) {
          context.warn(`${file.path}: skipped invalid package name "${excerpt(resolved.name, 60)}"`);
          continue;
        }
        if (usesPrivateRegistry(resolved.name, npmrc)) {
          skippedPrivate.add(resolved.name);
          continue;
        }
        refs.push({
          name: resolved.name,
          file: file.path,
          line: loc.key(declared, from),
          spec: resolved.spec,
          version: EXACT_VERSION.exec(resolved.spec)?.[1] ?? locked(declared),
        });
      }
    }
  }
  if (skippedPrivate.size > 0) {
    context.warn(`deps: skipped ${skippedPrivate.size} package(s) that use a private registry set in .npmrc`);
  }
  return refs;
}

const cache = new WeakMap<ScanContext, Promise<DepsData>>();

function dataFor(context: ScanContext): Promise<DepsData> {
  const cached = cache.get(context);
  if (cached) return cached;
  const pending = (async (): Promise<DepsData> => {
    const options = context.options as DepsOptions;
    const refs = await collectRefs(context);
    if (options.offline) {
      context.warn('deps: offline, so only DEPS-002 and DEPS-006 ran; the other deps rules need the registry');
      return { refs, options };
    }
    const fetcher = options.fetch ?? (globalThis.fetch as FetchLike);
    const registryUrl = options.registryUrl ?? DEFAULT_REGISTRY_URL;
    const names = [...new Set(refs.map((r) => r.name))];
    const results = await mapLimit(names, (name) => fetchPackument(fetcher, registryUrl, name));
    const lookups = new Map(names.map((name, i) => [name, results[i]!]));

    const failed = names.filter((name) => lookups.get(name)!.status === 'error');
    if (failed.length > 0) {
      const first = lookups.get(failed[0]!) as Extract<Lookup, { status: 'error' }>;
      context.warn(
        `deps: results are incomplete, could not check ${failed.length} of ${names.length} package(s) on the registry (${failed[0]}: ${first.message})`,
      );
    }
    return { refs, lookups, options };
  })();
  cache.set(context, pending);
  return pending;
}

function finding(rule: Pick<Rule, 'id' | 'severity'>, ref: DepRef, message: string, fix: string): Finding {
  return { ruleId: rule.id, severity: rule.severity, message, file: ref.file, line: ref.line, fix };
}

/** One finding per reference to a package found on the registry. */
async function registryFindings(
  context: ScanContext,
  check: (ref: DepRef, packument: Packument) => Finding | undefined,
): Promise<Finding[]> {
  const { refs, lookups } = await dataFor(context);
  const out: Finding[] = [];
  for (const ref of refs) {
    const lookup = lookups?.get(ref.name);
    if (lookup?.status !== 'found' || lookup.packument.unpublished) continue;
    const result = check(ref, lookup.packument);
    if (result) out.push(result);
  }
  return out;
}

/** The two most recently published versions, newest first. */
function latestTwoVersions(packument: Packument): [string, string] | undefined {
  const published = Object.keys(packument.versions)
    .filter((v) => packument.times[v] !== undefined)
    .sort((a, b) => Date.parse(packument.times[b]!) - Date.parse(packument.times[a]!));
  return published.length >= 2 ? [published[0]!, published[1]!] : undefined;
}

export const rules: Rule[] = [
  {
    id: 'DEPS-001',
    severity: 'high',
    title: 'Package does not exist on the registry',
    async check(context) {
      const { refs, lookups } = await dataFor(context);
      const fix = 'check the name is real before installing; agents invent package names that attackers then register';
      const out: Finding[] = [];
      for (const ref of refs) {
        const lookup = lookups?.get(ref.name);
        if (!lookup || lookup.status === 'error') continue;
        if (lookup.status === 'missing') {
          out.push(finding(this, ref, `"${ref.name}" does not exist on the npm registry`, fix));
        } else if (lookup.packument.unpublished) {
          out.push(finding(this, ref, `"${ref.name}" was unpublished from the npm registry`, fix));
        } else if (ref.version && !(ref.version in lookup.packument.versions)) {
          out.push(finding(this, ref, `"${ref.name}" has no published version ${ref.version}`, fix));
        }
      }
      return out;
    },
  },
  {
    id: 'DEPS-002',
    severity: 'high',
    title: 'Name very close to a popular package',
    async check(context) {
      const { refs, options, lookups } = await dataFor(context);
      const suspects = [...new Set(refs.map((r) => r.name))].filter((name) => typosquatTarget(name));
      const established = new Set<string>();
      if (lookups) {
        const fetcher = options.fetch ?? (globalThis.fetch as FetchLike);
        const url = options.downloadsUrl ?? DEFAULT_DOWNLOADS_URL;
        const counts = await mapLimit(suspects, (name) => fetchWeeklyDownloads(fetcher, url, name));
        suspects.forEach((name, i) => {
          if ((counts[i] ?? 0) >= ESTABLISHED_WEEKLY_DOWNLOADS) established.add(name);
        });
      }
      return refs
        .filter((ref) => suspects.includes(ref.name) && !established.has(ref.name))
        .map((ref) => {
          const target = typosquatTarget(ref.name)!;
          return finding(this, ref, `"${ref.name}" is very close to the popular package "${target}"`, `confirm you meant this package and not "${target}"`);
        });
    },
  },
  {
    id: 'DEPS-003',
    severity: 'medium',
    title: 'Recent maintainer or owner change',
    check(context) {
      return registryFindings(context, (ref, packument) => {
        const pair = latestTwoVersions(packument);
        if (!pair) return undefined;
        const [newest, previous] = pair;
        const before = packument.versions[previous]!.maintainers;
        const added = packument.versions[newest]!.maintainers.filter((m) => !before.includes(m));
        // Older packuments may omit maintainers on a version, which says nothing about a change.
        if (before.length === 0 || added.length === 0) return undefined;
        return finding(
          this,
          ref,
          `"${ref.name}" gained maintainer(s) in ${newest}, compared with ${previous}: ${added.join(', ')}`,
          'review what changed in the newest release, and stay on a version you have reviewed until you are satisfied',
        );
      });
    },
  },
  {
    id: 'DEPS-004',
    severity: 'medium',
    title: 'Newly published package',
    check(context) {
      const { minAgeDays } = context.config.deps;
      const now = Date.now();
      return registryFindings(context, (ref, packument) => {
        const created = Date.parse(packument.created ?? '');
        if (Number.isNaN(created)) return undefined;
        const ageDays = Math.floor((now - created) / DAY_MS);
        if (ageDays >= minAgeDays) return undefined;
        return finding(
          this,
          ref,
          `"${ref.name}" was first published ${ageDays} day(s) ago (minimum ${minAgeDays})`,
          'review the package and its maintainer before using it, or wait until it has a track record',
        );
      });
    },
  },
  {
    id: 'DEPS-005',
    severity: 'medium',
    title: 'Install scripts present',
    check(context) {
      return registryFindings(context, (ref, packument) => {
        const version = ref.version ?? packument.latest;
        const scripts = version ? packument.versions[version]?.scripts : undefined;
        const hook = INSTALL_HOOKS.find((h) => scripts?.[h]);
        if (!hook) return undefined;
        return finding(
          this,
          ref,
          `"${ref.name}@${version}" runs a ${hook} script: ${excerpt(scripts![hook]!, 60)}`,
          'review the script; install with --ignore-scripts or allow only the packages that need it',
        );
      });
    },
  },
  {
    id: 'DEPS-006',
    severity: 'low',
    title: 'Unpinned version',
    async check(context) {
      const { refs } = await dataFor(context);
      return refs
        .filter((ref) => UNPINNED_SPEC.test(ref.spec))
        .map((ref) =>
          finding(
            this,
            ref,
            `"${ref.name}" accepts any version ("${ref.spec}")`,
            'pin a version or range, and commit a lock file so that installs are repeatable',
          ),
        );
    },
  },
  {
    id: 'DEPS-007',
    severity: 'low',
    title: 'Deprecated package',
    check(context) {
      return registryFindings(context, (ref, packument) => {
        const version = ref.version ?? packument.latest;
        const deprecated = version ? packument.versions[version]?.deprecated : undefined;
        if (!deprecated) return undefined;
        return finding(
          this,
          ref,
          `"${ref.name}@${version}" is deprecated: ${excerpt(deprecated, 80)}`,
          'move to the suggested replacement or a maintained alternative',
        );
      });
    },
  },
];

export const depsScanner: Scanner = {
  name: 'deps',
  rules,
  findTargets: findDepsTargets,
};
