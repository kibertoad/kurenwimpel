import { ExitCode, run } from '../src/index.js';
import type { CliIo } from '../src/index.js';
import { README_FLAG } from './readme-flag.js';

export interface TestBucket {
  variant: string;
  weight: number;
}

export interface TestCondition {
  attribute?: string;
  operator: string;
  value?: string;
  segments?: string[];
}

export interface TestRule {
  id: string;
  conditions: TestCondition[];
  variant?: string;
  rollout?: TestBucket[] | { buckets: TestBucket[]; seed?: string; bucketBy?: string };
}

export interface TestFlag {
  key: string;
  enabled: boolean;
  variants: Record<string, boolean>;
  defaultVariant: string;
  offVariant: string;
  metadata?: Record<string, string>;
  prerequisites?: { flag: string; variants: string[] }[];
  targets?: { variant: string; keys: string[] }[];
  allocation?: { percent: number; seed?: string; bucketBy?: string };
  rules?: TestRule[];
  rollout?: TestBucket[];
  salt?: string;
}

export interface TestSegment {
  key: string;
  included?: string[];
  excluded?: string[];
  rules?: { id: string; conditions: TestCondition[] }[];
}

/** A ruleset loose enough for a test to edit in place before it is parsed. */
export interface TestRuleset {
  schemaVersion: number;
  flags: TestFlag[];
  segments: TestSegment[];
}

/** The README flag of a ruleset, and its rules. */
export function checkout(ruleset: TestRuleset): { flag: TestFlag; rules: TestRule[] } {
  const flag = ruleset.flags[0]!;
  return { flag, rules: flag.rules! };
}

/** What the example needs around it to resolve: its prerequisite and its segment. */
export function readmeRuleset(): TestRuleset {
  return structuredClone({
    schemaVersion: 1,
    flags: [
      README_FLAG,
      {
        key: 'new-backend',
        enabled: true,
        variants: { on: true, off: false },
        defaultVariant: 'on',
        offVariant: 'off',
      },
    ],
    segments: [
      {
        key: 'employees',
        included: ['emp-1', 'emp-2'],
        rules: [
          {
            id: 'staff-email',
            conditions: [{ attribute: 'email', operator: 'endsWith', value: '@example.com' }],
          },
        ],
      },
    ],
  });
}

export interface CliOutcome {
  readonly code: ExitCode;
  readonly stdout: string;
  readonly stderr: string;
}

/** Runs the CLI in memory. `files` maps a path to its parsed content, or to raw text. */
export async function runCli(
  argv: readonly string[],
  files: Readonly<Record<string, unknown>> = {},
): Promise<CliOutcome> {
  let stdout = '';
  let stderr = '';
  const io: CliIo = {
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
    readFile: (path) => {
      if (!Object.hasOwn(files, path)) return Promise.reject(new Error('ENOENT: no such file'));
      const content = files[path];
      return Promise.resolve(typeof content === 'string' ? content : JSON.stringify(content));
    },
  };
  const code = await run(argv, io);
  return { code, stdout, stderr };
}

export { ExitCode };
