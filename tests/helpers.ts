import { mkdtemp, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { DEFAULT_CONFIG } from '../src/core/config.js';
import { createNodeProvider } from '../src/core/node-provider.js';
import { runScanner } from '../src/core/runner.js';
import type { Finding, Scanner } from '../src/core/types.js';
import { main, type CliIO } from '../src/cli/index.js';

export const FIXTURES = fileURLToPath(new URL('./fixtures/', import.meta.url));

export function fixture(...parts: string[]): string {
  return join(FIXTURES, ...parts);
}

/**
 * Secret-shaped values generated at run time so the repository never holds
 * strings that look like real credentials.
 */
export const FAKE: Record<string, string> = {
  __FAKE_AWS_ID__: `AKIA${'Q7Z3'.repeat(4)}`,
  __FAKE_GITHUB_TOKEN__: `ghp_${'f4K3'.repeat(9)}`,
  __FAKE_STRIPE_LIVE__: `sk_live_${'0fAk3'.repeat(5)}`,
  __FAKE_SLACK__: `xoxb-${'1234567890'}-${'fakefakefake'}`,
  __FAKE_PEM__: ['-----BEGIN RSA PRIVATE KEY-----', 'bm90LWEtcmVhbC1rZXk=', '-----END RSA PRIVATE KEY-----'].join('\n'),
};

function fillPlaceholders(text: string): string {
  return text.replace(/__FAKE_[A-Z_]+__/g, (p) => FAKE[p] ?? p);
}

/**
 * Copy a fixture folder to a temp directory, renaming `dot.*` entries to `.*`
 * and filling token placeholders. See tests/fixtures/README.md.
 */
export async function materialize(src: string): Promise<string> {
  const dest = await mkdtemp(join(tmpdir(), 'surfscan-'));
  async function copy(from: string, to: string): Promise<void> {
    await mkdir(to, { recursive: true });
    for (const entry of await readdir(from, { withFileTypes: true })) {
      const name = entry.name.startsWith('dot.') ? entry.name.slice(3) : entry.name;
      if (entry.isDirectory()) await copy(join(from, entry.name), join(to, name));
      else await writeFile(join(to, name), fillPlaceholders(await readFile(join(from, entry.name), 'utf8')));
    }
  }
  await copy(src, dest);
  return dest;
}

/** Run one scanner over tests/fixtures/<ruleId>/<variant> and keep that rule's findings. */
export async function scanFixture(
  scanner: Scanner,
  ruleId: string,
  variant: 'bad' | 'clean',
  options?: Record<string, unknown>,
): Promise<Finding[]> {
  const root = await materialize(fixture(ruleId, variant));
  const result = await runScanner(scanner, {
    provider: createNodeProvider(root),
    config: DEFAULT_CONFIG,
    options,
  });
  return result.findings.filter((f) => f.ruleId === ruleId);
}

export interface CliRun {
  code: number;
  stdout: string;
  stderr: string;
}

export async function runCli(args: string[], cwd = FIXTURES): Promise<CliRun> {
  let stdout = '';
  let stderr = '';
  const io: CliIO = {
    stdout: (t) => {
      stdout += t;
    },
    stderr: (t) => {
      stderr += t;
    },
    cwd,
    env: {},
    isTTY: false,
  };
  const code = await main(args, io);
  return { code, stdout, stderr };
}
