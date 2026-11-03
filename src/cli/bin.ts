#!/usr/bin/env node
import { createInterface } from 'node:readline/promises';
import { main } from './index.js';

async function confirm(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return /^y(?:es)?$/i.test((await rl.question(question)).trim());
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
