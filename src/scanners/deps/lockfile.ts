import { stripBom } from '../../core/text.js';

export const LOCK_FILE_NAMES = ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock'];

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function fromPackageLock(content: string, name: string, prefix: string): string | undefined {
  const lock: unknown = JSON.parse(stripBom(content));
  const packages = (lock as { packages?: Record<string, { version?: unknown }> } | null)?.packages;
  const entry = packages?.[`${prefix}node_modules/${name}`] ?? packages?.[`node_modules/${name}`];
  return typeof entry?.version === 'string' ? entry.version : undefined;
}

// Line-based so that reading a lock file needs no YAML dependency.
function fromPnpmLock(content: string, name: string): string | undefined {
  const quoted = escapeRegex(name);
  const importer = new RegExp(`^\\s+['"]?${quoted}['"]?:\\r?\\n\\s+specifier:.*\\r?\\n\\s+version:\\s*['"]?(\\d[^\\s('"]*)`, 'm').exec(content);
  if (importer) return importer[1];
  return new RegExp(`^\\s+['"]?/?${quoted}@(\\d[^\\s('":]*)['"]?:`, 'm').exec(content)?.[1];
}

function fromYarnLock(content: string, name: string): string | undefined {
  const entry = new RegExp(`^"?${escapeRegex(name)}@[^\\n]*:\\r?\\n\\s+version:?\\s+"?([^"\\s]+)`, 'm');
  return entry.exec(content)?.[1];
}

/** The version a lock file resolves a direct dependency to. `prefix` locates a workspace in a root package-lock. */
export function lockedVersion(fileName: string, content: string, name: string, prefix: string): string | undefined {
  if (fileName === 'package-lock.json') return fromPackageLock(content, name, prefix);
  if (fileName === 'pnpm-lock.yaml') return fromPnpmLock(content, name);
  return fromYarnLock(content, name);
}
