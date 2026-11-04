#!/usr/bin/env node
import { createInterface } from 'node:readline/promises';
import { main } from './index.js';

async function confirm(question: string, opts?: { exact?: string }): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = (await rl.question(question)).trim();
    return opts?.exact !== undefined ? answer === opts.exact : /^y(?:es)?$/i.test(answer);
  } finally {
    rl.close();
  }
}

const code = await main(process.argv.slice(2), {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
  cwd: process.cwd(),
  env: process.env,
  isTTY: Boolean(process.stdout.isTTY),
  ...(process.stdin.isTTY ? { confirm } : {}),
});
process.exitCode = code;
