import { describe, expect, it } from 'vitest';

import { ExitCode, readmeRuleset, runCli } from './fixtures.js';

/** Pretty-printed, as a ruleset in a repository is, so each definition has its own lines. */
function pretty(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function broken(): string {
  const ruleset = readmeRuleset();
  ruleset.flags[1]!.offVariant = 'missing';
  return pretty(ruleset);
}

function lineOfKey(text: string, key: string): number {
  return text.split('\n').findIndex((line) => line.includes(`"key": "${key}"`)) + 1;
}

describe('kurenwimpel validate --format github', () => {
  it('annotates the line that defines the broken flag', async () => {
    const text = broken();
    const { code, stdout } = await runCli(['validate', '-f', 'github', 'flags/prod.json'], {
      'flags/prod.json': text,
    });

    expect(code).toBe(ExitCode.Findings);
    expect(stdout.split('\n')).toEqual([
      `::error file=flags/prod.json,line=${lineOfKey(text, 'new-backend')},title=kurenwimpel%3A new-backend::flag new-backend: offVariant points at unknown variant missing`,
      `::error file=flags/prod.json,line=${lineOfKey(text, 'new-checkout')},title=kurenwimpel%3A new-checkout::flag new-checkout: prerequisite new-backend is not in this ruleset`,
      '',
    ]);
  });

  it('uses the JSON parser line for a file that is not JSON', async () => {
    const { stdout } = await runCli(['validate', '-f', 'github', 'x.json'], {
      'x.json': '{\n  "flags": []\n  "segments": []\n}\n',
    });
    expect(stdout).toMatch(/^::error file=x\.json,line=3,title=kurenwimpel%3A \$::/u);
  });

  it('prints nothing for a valid file', async () => {
    const { code, stdout } = await runCli(['validate', '-f', 'github', 'ok.json'], {
      'ok.json': pretty(readmeRuleset()),
    });
    expect(code).toBe(ExitCode.Ok);
    expect(stdout).toBe('');
  });
});

describe('kurenwimpel validate --format markdown', () => {
  it('lists each file and its issues', async () => {
    const { stdout } = await runCli(['validate', '-f', 'markdown', 'ok.json', 'bad.json'], {
      'ok.json': readmeRuleset(),
      'bad.json': broken(),
    });

    expect(stdout).toContain('### Validation\n\n`ok.json`: no issues (2 flags, 1 segment).\n');
    expect(stdout).toContain(
      '`bad.json`: **2 issues** (1 flag, 1 segment loaded).\n\n- `new-backend`: flag new-backend: ',
    );
  });
});
