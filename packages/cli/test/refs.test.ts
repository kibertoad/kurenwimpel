import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { findReferences, listFiles } from '../src/index.js';
import type { RefsReport } from '../src/index.js';
import { ExitCode, runCli } from './fixtures.js';

const flag = (key: string): Record<string, unknown> => ({
  key,
  enabled: true,
  variants: { on: true, off: false },
  defaultVariant: 'off',
  offVariant: 'off',
});

describe('findReferences', () => {
  it('finds a string literal key passed to every getter', () => {
    const source = [
      "client.getBoolean('a', false);",
      'client.getString("b", "x");',
      'client.getNumber(`c`, 0);',
      "client.getObject<Limits>('d', {});",
      "await of.getBooleanValue('e', false);",
      "client.getStringDetails(\n  'f',\n  'x',\n);",
      "client.evaluate('g', context);",
    ].join('\n');

    expect(findReferences('src\\app.ts', source)).toEqual([
      { key: 'a', file: 'src/app.ts', line: 1 },
      { key: 'b', file: 'src/app.ts', line: 2 },
      { key: 'c', file: 'src/app.ts', line: 3 },
      { key: 'd', file: 'src/app.ts', line: 4 },
      { key: 'e', file: 'src/app.ts', line: 5 },
      { key: 'f', file: 'src/app.ts', line: 6 },
      { key: 'g', file: 'src/app.ts', line: 10 },
    ]);
  });

  it('skips keys it cannot read and calls that are not getters', () => {
    const source = [
      'client.getBoolean(key, false);',
      'client.getBoolean(`flag-${name}`, false);',
      "client.evaluateAll('x');",
      "forgetBoolean('y');",
      "getBooleanish('z');",
    ].join('\n');
    expect(findReferences('a.ts', source)).toEqual([]);
  });
});

describe('kurenwimpel refs', () => {
  const files = {
    'flags.json': { flags: [flag('used'), flag('stale')] },
    'src/app.ts': "if (client.getBoolean('used', false)) start();\n",
    'src/old.js': "\n\nclient.getString('removed-long-ago', 'a');\n",
    'src/notes.md': "client.getBoolean('stale', false)",
  };

  it('reports unreferenced flags and unknown keys, and exits 1', async () => {
    const { code, stdout } = await runCli(
      ['refs', 'flags.json', '--src', 'src', '-f', 'json'],
      files,
    );
    expect(code).toBe(ExitCode.Findings);
    expect(JSON.parse(stdout)).toEqual<RefsReport>({
      file: 'flags.json',
      sources: ['src'],
      flags: 2,
      files: 2,
      references: [
        { key: 'used', file: 'src/app.ts', line: 1 },
        { key: 'removed-long-ago', file: 'src/old.js', line: 3 },
      ],
      unreferenced: ['stale'],
      unknown: [{ key: 'removed-long-ago', file: 'src/old.js', line: 3 }],
    });
  });

  it('exits 0 when every flag is read and every key exists', async () => {
    const { code, stdout } = await runCli(['refs', 'flags.json', '--src', 'src'], {
      'flags.json': [flag('used')],
      'src/app.ts': files['src/app.ts'],
    });
    expect(code).toBe(ExitCode.Ok);
    expect(stdout).toBe('flags.json: 1 flag, 1 reference in 1 source file\n');
  });

  it('prints text, markdown and annotations', async () => {
    const text = await runCli(['refs', 'flags.json', '--src', 'src'], files);
    expect(text.stdout).toBe(
      [
        'flags.json: 2 flags, 2 references in 2 source files',
        '  [unreferenced] stale',
        '  [unknown] src/old.js:3 names "removed-long-ago", which is not a flag',
        '',
      ].join('\n'),
    );

    const markdown = await runCli(['refs', 'flags.json', '--src', 'src', '-f', 'markdown'], files);
    expect(markdown.stdout).toContain('Flags no code reads:\n\n- `stale`\n');
    expect(markdown.stdout).toContain('- `removed-long-ago` at `src/old.js:3`\n');

    const github = await runCli(['refs', 'flags.json', '--src', 'src', '-f', 'github'], files);
    expect(github.stdout).toContain(
      '::warning file=src/old.js,line=3,title=kurenwimpel refs%3A unknown flag::"removed-long-ago" is not a flag in flags.json\n',
    );
    expect(github.stdout).toContain('title=kurenwimpel refs%3A unreferenced::stale is not read');
  });

  it('needs --src', async () => {
    const { code, stderr } = await runCli(['refs', 'flags.json'], files);
    expect(code).toBe(ExitCode.Usage);
    expect(stderr).toContain('expected --src <dir>');
  });
});

describe('listFiles', () => {
  it('lists files recursively, skipping node_modules and dot directories', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kurenwimpel-refs-'));
    try {
      await Promise.all(
        ['src/nested', 'node_modules/pkg', '.git'].map((directory) =>
          mkdir(join(root, directory), { recursive: true }),
        ),
      );
      await Promise.all(
        ['src/a.ts', 'src/nested/b.ts', 'node_modules/pkg/c.js', '.git/d.js'].map((file) =>
          writeFile(join(root, file), ''),
        ),
      );
      expect(await listFiles(root)).toEqual([
        join(root, 'src', 'a.ts'),
        join(root, 'src', 'nested', 'b.ts'),
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
