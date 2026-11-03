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

/** Run one scanner over tests/fixtures/<ruleId>/<variant> and keep that rule's findings. */
export async function scanFixture(scanner: Scanner, ruleId: string, variant: 'bad' | 'clean'): Promise<Finding[]> {
  const result = await runScanner(scanner, {
    provider: createNodeProvider(fixture(ruleId, variant)),
    config: DEFAULT_CONFIG,
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
