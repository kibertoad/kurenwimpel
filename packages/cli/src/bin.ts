#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';

import { run } from './cli.js';

process.exitCode = await run(process.argv.slice(2), {
  stdout: (text) => {
    process.stdout.write(text);
  },
  stderr: (text) => {
    process.stderr.write(text);
  },
  readFile: (path) => readFile(path, 'utf8'),
  writeFile: (path, text) => writeFile(path, text, 'utf8'),
  env: process.env,
  fetch: globalThis.fetch,
  now: () => new Date(),
});
