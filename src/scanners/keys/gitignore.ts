/**
 * Minimal .gitignore matcher: enough to answer "is this file ignored by the
 * project's own ignore files". It reads `.gitignore` files on the path from
 * the root to the file, plus `.git/info/exclude`. It does not read the
 * user's global excludes file, because surfscan only reads the project.
 */
import type { SourceProvider } from '../../core/types.js';

interface IgnorePattern {
  /** Directory the pattern is relative to ('' for the root), no trailing slash. */
  base: string;
  regex: RegExp;
  negate: boolean;
  dirOnly: boolean;
}

function escapeRegex(ch: string): string {
  return /[\\^$.+()|{}]/.test(ch) ? `\\${ch}` : ch;
}

function globToRegex(glob: string): string {
  let out = '';
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i]!;
    if (ch === '*') {
      if (glob[i + 1] === '*') {
        const atStart = i === 0 || glob[i - 1] === '/';
        const next = glob[i + 2];
        if (atStart && next === '/') {
          out += '(?:.*/)?';
          i += 2;
        } else if (atStart && next === undefined) {
          out += '.*';
          i += 1;
        } else {
          out += '[^/]*';
          i += 1;
        }
      } else {
        out += '[^/]*';
      }
    } else if (ch === '?') {
      out += '[^/]';
    } else if (ch === '[') {
      const end = glob.indexOf(']', i + 1);
      if (end === -1) {
        out += '\\[';
      } else {
        let cls = glob.slice(i + 1, end);
        if (cls.startsWith('!')) cls = `^${cls.slice(1)}`;
        out += `[${cls.replace(/\\/g, '\\\\')}]`;
        i = end;
      }
    } else if (ch === '\\' && i + 1 < glob.length) {
      const next = glob[++i]!;
      out += /[A-Za-z0-9]/.test(next) ? next : `\\${next}`;
    } else {
      out += escapeRegex(ch);
    }
  }
  return out;
}

export function parseGitignore(text: string, base: string): IgnorePattern[] {
  const patterns: IgnorePattern[] = [];
  for (let raw of text.split(/\r?\n/)) {
    raw = raw.replace(/(?<!\\)\s+$/, '');
    if (raw === '' || raw.startsWith('#')) continue;
    let negate = false;
    if (raw.startsWith('!')) {
      negate = true;
      raw = raw.slice(1);
    } else if (raw.startsWith('\\!') || raw.startsWith('\\#')) {
      raw = raw.slice(1);
    }
    let dirOnly = false;
    if (raw.endsWith('/')) {
      dirOnly = true;
      raw = raw.slice(0, -1);
    }
    const anchored = raw.includes('/');
    if (raw.startsWith('/')) raw = raw.slice(1);
    if (raw === '') continue;
    const body = globToRegex(raw);
    const prefix = base === '' ? '' : `${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/`;
    const source = anchored ? `^${prefix}${body}$` : `^${prefix}(?:.*/)?${body}$`;
    patterns.push({ base, regex: new RegExp(source), negate, dirOnly });
  }
  return patterns;
}

function isIgnoredBy(patterns: IgnorePattern[], path: string, isDir: boolean): boolean | undefined {
  let result: boolean | undefined;
  for (const p of patterns) {
    if (p.dirOnly && !isDir) continue;
    if (p.regex.test(path)) result = !p.negate;
  }
  return result;
}

export class GitignoreChecker {
  private readonly cache = new Map<string, IgnorePattern[]>();

  constructor(private readonly provider: SourceProvider) {}

  private async patternsFor(dir: string): Promise<IgnorePattern[]> {
    const cached = this.cache.get(dir);
    if (cached) return cached;
    const file = dir === '' ? '.gitignore' : `${dir}/.gitignore`;
    let patterns: IgnorePattern[] = [];
    try {
      const text = await this.provider.read(file);
      if (text !== undefined) patterns = parseGitignore(text, dir);
      if (dir === '') {
        const exclude = await this.provider.read('.git/info/exclude');
        if (exclude !== undefined) patterns = [...parseGitignore(exclude, ''), ...patterns];
      }
    } catch {
      // Unreadable ignore file: treat as empty.
    }
    this.cache.set(dir, patterns);
    return patterns;
  }

  /** True when the project's ignore files exclude `path` (relative, forward slashes). */
  async isIgnored(path: string): Promise<boolean> {
    const parts = path.split('/');
    // Collect patterns from the root down to the file's directory, in order,
    // so deeper files override shallower ones.
    const all: IgnorePattern[] = [];
    for (let i = 0; i < parts.length; i++) {
      const dir = parts.slice(0, i).join('/');
      all.push(...(await this.patternsFor(dir)));
      const current = parts.slice(0, i + 1).join('/');
      const isDir = i < parts.length - 1;
      const ignored = isIgnoredBy(all, current, isDir);
      // An ignored parent directory cannot be re-included by a later pattern.
      if (isDir && ignored) return true;
      if (!isDir) return ignored ?? false;
    }
    return false;
  }
}
