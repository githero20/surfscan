import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../src/core/config.js';
import { createNodeProvider, MAX_FILE_BYTES } from '../src/core/node-provider.js';
import { DEFAULT_IGNORE_PATHS, runScanner } from '../src/core/runner.js';
import type { Rule, SourceProvider } from '../src/core/types.js';
import { GitignoreChecker, parseGitignore } from '../src/scanners/keys/gitignore.js';

async function project(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'surfscan-fs-'));
  for (const [path, content] of Object.entries(files)) {
    const full = join(root, path);
    await mkdir(join(full, '..'), { recursive: true });
    await writeFile(full, content);
  }
  return root;
}

describe('node provider: list', () => {
  it('returns paths relative to the root with forward slashes, sorted', async () => {
    const root = await project({ 'b.md': '', 'a/z.md': '', 'a/b/c.md': '' });
    expect(await createNodeProvider(root).list(['**/*.md'], [])).toEqual(['a/b/c.md', 'a/z.md', 'b.md']);
  });

  it('includes dot files and dot folders', async () => {
    const root = await project({ '.env': '', '.cursor/mcp.json': '', 'x.txt': '' });
    expect(await createNodeProvider(root).list(['**/.env', '**/.cursor/mcp.json'], [])).toEqual(['.cursor/mcp.json', '.env']);
  });

  it('honours ignore globs, including the default ones', async () => {
    const root = await project({ 'CLAUDE.md': '', 'node_modules/p/CLAUDE.md': '', '.git/CLAUDE.md': '', 'vendor/CLAUDE.md': '' });
    const provider = createNodeProvider(root);
    expect(await provider.list(['**/CLAUDE.md'], [...DEFAULT_IGNORE_PATHS, 'vendor/**'])).toEqual(['CLAUDE.md']);
    expect(await provider.list(['**/CLAUDE.md'], [])).toHaveLength(4);
  });

  it('returns files only, not folders', async () => {
    const root = await project({ 'dir.md/inner.txt': '' });
    expect(await createNodeProvider(root).list(['**/*.md'], [])).toEqual([]);
  });

  it('returns an empty list for a root with no matches', async () => {
    const root = await project({ 'a.txt': '' });
    expect(await createNodeProvider(root).list(['**/*.md'], [])).toEqual([]);
  });

  it('does not follow symbolic links out of the project', async () => {
    const outside = await project({ 'secret.md': 'outside' });
    const root = await project({ 'a.md': '' });
    try {
      await symlink(outside, join(root, 'link'), 'junction');
    } catch {
      return; // creating links is not permitted on this machine
    }
    expect(await createNodeProvider(root).list(['**/*.md'], [])).toEqual(['a.md']);
  });
});

describe('node provider: read', () => {
  it('reads a file as UTF-8', async () => {
    const root = await project({ 'a.md': 'héllo 😀' });
    expect(await createNodeProvider(root).read('a.md')).toBe('héllo 😀');
  });

  it('reads files in subfolders by relative path', async () => {
    const root = await project({ 'a/b/c.md': 'deep' });
    expect(await createNodeProvider(root).read('a/b/c.md')).toBe('deep');
  });

  it('returns undefined for a file that does not exist', async () => {
    const root = await project({});
    expect(await createNodeProvider(root).read('nope.md')).toBeUndefined();
  });

  it('returns undefined for a folder', async () => {
    const root = await project({ 'dir/x.md': '' });
    expect(await createNodeProvider(root).read('dir')).toBeUndefined();
  });

  it('reads an empty file as the empty string', async () => {
    const root = await project({ 'empty.md': '' });
    expect(await createNodeProvider(root).read('empty.md')).toBe('');
  });

  it('accepts a file of exactly the size limit', async () => {
    const root = await project({ 'edge.txt': 'a'.repeat(MAX_FILE_BYTES) });
    expect(await createNodeProvider(root).read('edge.txt')).toHaveLength(MAX_FILE_BYTES);
  });

  it('refuses a file larger than the limit, naming the limit', async () => {
    const root = await project({ 'big.txt': 'a'.repeat(MAX_FILE_BYTES + 1) });
    await expect(createNodeProvider(root).read('big.txt')).rejects.toThrow(`larger than ${MAX_FILE_BYTES} bytes`);
  });

  it('the limit is 2 MiB', () => {
    expect(MAX_FILE_BYTES).toBe(2 * 1024 * 1024);
  });

  it('a file over the limit becomes a warning and an incomplete result, not a crash', async () => {
    const root = await project({ 'CLAUDE.md': 'ok', 'AGENTS.md': 'a'.repeat(MAX_FILE_BYTES + 1) });
    const seen: string[] = [];
    const rule: Rule = { id: 'T-001', severity: 'high', title: 't', check: (c) => (seen.push(...c.files.map((f) => f.path)), []) };
    const provider = createNodeProvider(root);
    const result = await runScanner(
      { name: 't', rules: [rule], findTargets: (p) => p.list(['*.md'], []) },
      { provider, config: DEFAULT_CONFIG },
    );
    expect(seen).toEqual(['CLAUDE.md']);
    expect(result.warnings).toEqual([expect.stringMatching(/^AGENTS\.md: skipped \(larger than 2097152 bytes\)$/)]);
    expect(result.incomplete).toBe(true);
  });
});

/** A provider that serves only the given files, for the ignore-file tests. */
const memory = (files: Record<string, string>): SourceProvider => ({
  list: async () => Object.keys(files),
  read: async (path) => files[path],
});

const ignored = async (gitignore: string, path: string, extra: Record<string, string> = {}): Promise<boolean> =>
  new GitignoreChecker(memory({ '.gitignore': gitignore, ...extra })).isIgnored(path);

describe('gitignore matching', () => {
  it('matches a plain file name at any depth', async () => {
    expect(await ignored('.env', '.env')).toBe(true);
    expect(await ignored('.env', 'apps/web/.env')).toBe(true);
    expect(await ignored('.env', 'apps/web/.env.local')).toBe(false);
  });

  it('matches wildcards that do not cross folders', async () => {
    expect(await ignored('.env*', '.env.local')).toBe(true);
    expect(await ignored('*.pem', 'certs/server.pem')).toBe(true);
    expect(await ignored('a*b', 'a/b')).toBe(false);
    expect(await ignored('a?c', 'abc')).toBe(true);
    expect(await ignored('a?c', 'abbc')).toBe(false);
  });

  it('treats a pattern with a slash in the middle as anchored to the .gitignore folder', async () => {
    expect(await ignored('config/.env', 'config/.env')).toBe(true);
    expect(await ignored('config/.env', 'apps/config/.env')).toBe(false);
  });

  it('treats a leading slash as anchored to the root', async () => {
    expect(await ignored('/.env', '.env')).toBe(true);
    expect(await ignored('/.env', 'sub/.env')).toBe(false);
  });

  it('a trailing slash matches folders only, and everything inside them', async () => {
    expect(await ignored('secrets/', 'secrets/.env')).toBe(true);
    expect(await ignored('secrets/', 'a/secrets/.env')).toBe(true);
    expect(await ignored('secrets/', 'secrets')).toBe(false); // a file named secrets
  });

  it('supports ** in the middle, at the start and at the end', async () => {
    expect(await ignored('a/**/c.env', 'a/c.env')).toBe(true);
    expect(await ignored('a/**/c.env', 'a/b/x/c.env')).toBe(true);
    expect(await ignored('**/c.env', 'x/y/c.env')).toBe(true);
    expect(await ignored('a/**', 'a/b/c.env')).toBe(true);
  });

  it('supports character classes and negated classes', async () => {
    expect(await ignored('.env.[ab]', '.env.a')).toBe(true);
    expect(await ignored('.env.[ab]', '.env.c')).toBe(false);
    expect(await ignored('.env.[!ab]', '.env.c')).toBe(true);
  });

  it('a later negation re-includes a file', async () => {
    expect(await ignored('.env*\n!.env.example', '.env.example')).toBe(false);
    expect(await ignored('.env*\n!.env.example', '.env.local')).toBe(true);
  });

  it('the last matching pattern wins', async () => {
    expect(await ignored('!.env\n.env', '.env')).toBe(true);
    expect(await ignored('.env\n!.env', '.env')).toBe(false);
  });

  it('cannot re-include a file whose parent folder is ignored', async () => {
    expect(await ignored('secrets/\n!secrets/.env', 'secrets/.env')).toBe(true);
  });

  it('skips comments and blank lines', async () => {
    expect(await ignored('# .env\n\n   \n', '.env')).toBe(false);
  });

  it('a backslash makes a leading # or ! literal', async () => {
    expect(await ignored('\\#notes.env', '#notes.env')).toBe(true);
    expect(await ignored('\\!bang.env', '!bang.env')).toBe(true);
  });

  it('ignores trailing spaces', async () => {
    expect(await ignored('.env   ', '.env')).toBe(true);
  });

  it('reads Windows line endings', async () => {
    expect(await ignored('node_modules\r\n.env\r\n', '.env')).toBe(true);
  });

  it('applies a nested .gitignore only inside its own folder', async () => {
    const files = { 'apps/web/.gitignore': '.env' };
    expect(await ignored('', 'apps/web/.env', files)).toBe(true);
    expect(await ignored('', 'apps/api/.env', files)).toBe(false);
  });

  it('lets a nested .gitignore override the root one', async () => {
    const files = { 'apps/web/.gitignore': '!.env' };
    expect(await ignored('.env', 'apps/web/.env', files)).toBe(false);
    expect(await ignored('.env', 'apps/api/.env', files)).toBe(true);
  });

  it('reads .git/info/exclude', async () => {
    expect(await ignored('', '.env', { '.git/info/exclude': '.env' })).toBe(true);
  });

  it('is false when there is no .gitignore at all', async () => {
    expect(await new GitignoreChecker(memory({})).isIgnored('.env')).toBe(false);
  });

  it('treats an unreadable .gitignore as empty', async () => {
    const provider: SourceProvider = {
      list: async () => [],
      read: async () => {
        throw new Error('EACCES');
      },
    };
    expect(await new GitignoreChecker(provider).isIgnored('.env')).toBe(false);
  });

  it('reads each .gitignore once however many files it is asked about', async () => {
    let reads = 0;
    const provider: SourceProvider = {
      list: async () => [],
      read: async (path) => {
        if (path === '.gitignore') reads++;
        return path === '.gitignore' ? '.env' : undefined;
      },
    };
    const checker = new GitignoreChecker(provider);
    await checker.isIgnored('.env');
    await checker.isIgnored('a/.env');
    await checker.isIgnored('b/.env');
    expect(reads).toBe(1);
  });

  describe('parseGitignore', () => {
    it('returns one pattern per rule and marks negations and folder-only rules', () => {
      const patterns = parseGitignore('a\n!b\nc/\n# d\n', '');
      expect(patterns.map((p) => [p.negate, p.dirOnly])).toEqual([[false, false], [true, false], [false, true]]);
    });

    it('limits patterns to their own folder', () => {
      const [pattern] = parseGitignore('x.env', 'apps/web');
      expect(pattern!.regex.test('apps/web/x.env')).toBe(true);
      expect(pattern!.regex.test('apps/api/x.env')).toBe(false);
    });
  });
});
