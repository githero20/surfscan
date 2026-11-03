#!/usr/bin/env node
import { main } from './index.js';

const code = await main(process.argv.slice(2), {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
  cwd: process.cwd(),
  env: process.env,
  isTTY: Boolean(process.stdout.isTTY),
});
process.exitCode = code;
