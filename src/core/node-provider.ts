import { readFile, realpath, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';
import fg from 'fast-glob';
import type { SourceProvider } from './types.js';

/** Files larger than this are skipped with a warning, unless the scanner sets its own limit. */
export const MAX_FILE_BYTES = 2 * 1024 * 1024;

/** Folders that agents read as a whole, so a link to one matters even though no file pattern can match it. */
const AGENT_FOLDERS = '**/.{claude,codex,cursor,github,surfscan,vscode}';

const UTF16_LE = [0xff, 0xfe];
const UTF16_BE = [0xfe, 0xff];
const startsWith = (bytes: Buffer, mark: number[]): boolean => mark.every((b, i) => bytes[i] === b);

/** Windows PowerShell 5.1 writes UTF-16 with `>`, and agents read those files fine, so surfscan must too. */
function decode(bytes: Buffer): string {
  if (startsWith(bytes, UTF16_LE)) return new TextDecoder('utf-16le').decode(bytes);
  if (startsWith(bytes, UTF16_BE)) return new TextDecoder('utf-16be').decode(bytes);
  return bytes.toString('utf8');
}

/** Read-only file access rooted at a directory on disk. */
export function createNodeProvider(root: string): SourceProvider {
  const pendingLinks = new Set<string>();
  const reportedLinks = new Set<string>();

  /**
   * Links are not followed, so a link matching `patterns` would be missed without
   * a trace. A link to a file inside the project is read like any other file; it
   * adds nothing if its target is scanned anyway. Anything else is reported.
   */
  async function resolveLinks(patterns: string[], ignore: string[], paths: string[]): Promise<string[]> {
    const entries = await fg([...patterns, AGENT_FOLDERS], {
      cwd: root,
      dot: true,
      onlyFiles: false,
      objectMode: true,
      followSymbolicLinks: false,
      suppressErrors: true,
      ignore,
    });
    const realRoot = await realpath(root);
    const extra: string[] = [];
    for (const entry of entries) {
      if (!entry.dirent.isSymbolicLink() || paths.includes(entry.path)) continue;
      let target: string;
      let isFile: boolean;
      try {
        target = await realpath(join(root, entry.path));
        isFile = (await stat(target)).isFile();
      } catch {
        continue; // A broken link has nothing to scan.
      }
      const inside = relative(realRoot, target);
      if (isFile && !isAbsolute(inside) && !inside.startsWith(`..${sep}`)) {
        if (!paths.includes(inside.split(sep).join('/'))) extra.push(entry.path);
      } else if (!reportedLinks.has(entry.path)) {
        reportedLinks.add(entry.path);
        pendingLinks.add(entry.path);
      }
    }
    return extra;
  }

  return {
    async list(patterns, ignore) {
      const paths = await fg(patterns, {
        cwd: root,
        dot: true,
        onlyFiles: true,
        unique: true,
        followSymbolicLinks: false,
        suppressErrors: true,
        ignore,
      });
      return [...paths, ...(await resolveLinks(patterns, ignore, paths))].sort();
    },

    async read(path, opts) {
      const abs = join(root, path);
      const limit = opts?.maxBytes ?? MAX_FILE_BYTES;
      try {
        const info = await stat(abs);
        if (!info.isFile()) return undefined;
        if (info.size > limit) {
          throw new Error(`larger than ${limit} bytes`);
        }
        return decode(await readFile(abs));
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
        throw err;
      }
    },

    takeSkippedLinks() {
      const links = [...pendingLinks];
      pendingLinks.clear();
      return links;
    },
  };
}
