import { stripBom } from '../../core/text.js';

export const LOCK_FILE_NAMES = ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock'];

type VersionLookup = (name: string, prefix: string) => string | undefined;

function parsePackageLock(content: string): VersionLookup {
  const lock: unknown = JSON.parse(stripBom(content));
  const packages = (lock as { packages?: Record<string, { version?: unknown }> } | null)?.packages;
  return (name, prefix) => {
    const entry = packages?.[`${prefix}node_modules/${name}`] ?? packages?.[`node_modules/${name}`];
    return typeof entry?.version === 'string' ? entry.version : undefined;
  };
}

const remember = (map: Map<string, string>, name: string, version: string): void => {
  if (!map.has(name)) map.set(name, version);
};

// Line-based so that reading a lock file needs no YAML dependency.
function parsePnpmLock(content: string): VersionLookup {
  const importers = new Map<string, string>();
  const packages = new Map<string, string>();
  const lines = content.split(/\r?\n/);
  lines.forEach((line, i) => {
    const key = /^[ \t]+['"]?((?:@[^\s'"/]+\/)?[^\s'"@/:]+)['"]?:\s*$/.exec(line);
    if (key && /^\s+specifier:/.test(lines[i + 1] ?? '')) {
      const version = /^\s+version:\s*['"]?(\d[^\s('"]*)/.exec(lines[i + 2] ?? '');
      if (version) remember(importers, key[1]!, version[1]!);
    }
    const entry = /^[ \t]+['"]?\/?((?:@[^\s'"/]+\/)?[^\s'"@/]+)@(\d[^\s('":]*)['"]?:/.exec(line);
    if (entry) remember(packages, entry[1]!, entry[2]!);
  });
  return (name) => importers.get(name) ?? packages.get(name);
}

function parseYarnLock(content: string): VersionLookup {
  const versions = new Map<string, string>();
  const lines = content.split(/\r?\n/);
  lines.forEach((line, i) => {
    const entry = /^"?((?:@[^/\s"]+\/)?[^@\s"]+)@.*:\s*$/.exec(line);
    const version = entry && /^\s+version:?\s+"?([^"\s]+)/.exec(lines[i + 1] ?? '');
    if (version) remember(versions, entry[1]!, version[1]!);
  });
  return (name) => versions.get(name);
}

const PARSERS: Record<string, (content: string) => VersionLookup> = {
  'package-lock.json': parsePackageLock,
  'pnpm-lock.yaml': parsePnpmLock,
};

/** One lookup is made per dependency, so each lock file is parsed once. */
const parsed = new Map<string, VersionLookup>();
const MAX_PARSED = 16;

/** The version a lock file resolves a direct dependency to. `prefix` locates a workspace in a root package-lock. */
export function lockedVersion(fileName: string, content: string, name: string, prefix: string): string | undefined {
  let lookup = parsed.get(content);
  if (!lookup) {
    lookup = (PARSERS[fileName] ?? parseYarnLock)(content);
    if (parsed.size >= MAX_PARSED) parsed.clear();
    parsed.set(content, lookup);
  }
  return lookup(name, prefix);
}
