import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import fg from 'fast-glob';
import type { SourceProvider } from './types.js';

/** Files larger than this are skipped with a warning. */
export const MAX_FILE_BYTES = 2 * 1024 * 1024;

/** Read-only file access rooted at a directory on disk. */
export function createNodeProvider(root: string): SourceProvider {
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
      return paths.sort();
    },

    async read(path) {
      const abs = join(root, path);
      try {
        const info = await stat(abs);
        if (!info.isFile()) return undefined;
        if (info.size > MAX_FILE_BYTES) {
          throw new Error(`larger than ${MAX_FILE_BYTES} bytes`);
        }
        return await readFile(abs, 'utf8');
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
        throw err;
      }
    },
  };
}
