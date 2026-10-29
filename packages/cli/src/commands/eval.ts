import type { EvaluationContext } from '@kurenwimpel/core';

import {
  booleanOption,
  ExitCode,
  FORMAT_OPTION,
  formatOption,
  stringOption,
  UsageError,
} from '../command.js';
import type { Command } from '../command.js';
import { explain, snapshotOf } from '../eval/explain.js';
import type { Explanation } from '../eval/explain.js';
import { renderExplanations } from '../format/eval-format.js';
import { loadRuleset, parseJson, toJson, warnAboutIssues } from '../ruleset-file.js';

export interface EvalReport {
  readonly context: EvaluationContext;
  readonly results: readonly Explanation[];
}

export const evalCommand: Command = {
  name: 'eval',
  summary: 'Evaluate flags against a context and explain the outcome.',
  usage: [
    "Usage: kurenwimpel eval <file> (--flag <key> | --all) [--context '<json>'] [--format text|json]",
    '',
    'Prints the value, variant, reason, deciding rule and prerequisite outcomes.',
    '--context takes a JSON object in the OpenFeature flat shape and defaults to {}.',
    'Exits 1 when any evaluated flag reports an error code.',
  ].join('\n'),
  options: {
    ...FORMAT_OPTION,
    flag: { type: 'string' },
    all: { type: 'boolean' },
    context: { type: 'string', short: 'c' },
  },
  async run(args, io) {
    const format = formatOption(args, ['text', 'json']);
    const [path, ...extra] = args.positionals;
    if (path === undefined || extra.length > 0) throw new UsageError('expected exactly one file');

    const key = stringOption(args, 'flag');
    if ((key === undefined) === !booleanOption(args, 'all')) {
      throw new UsageError('pass exactly one of --flag <key> or --all');
    }

    const context = contextOption(stringOption(args, 'context'));
    const loaded = await loadRuleset(io, path);
    warnAboutIssues(io, loaded);

    const snapshot = snapshotOf(loaded.parsed);
    const keys = key === undefined ? [...snapshot.flags.keys()] : [key];
    const report: EvalReport = {
      context,
      results: keys.map((flagKey) => explain(snapshot, flagKey, context)),
    };

    io.stdout(format === 'json' ? toJson(report) : renderExplanations(report.results));
    const failed = report.results.some((result) => result.errorCode !== undefined);
    return failed ? ExitCode.Findings : ExitCode.Ok;
  },
};

function contextOption(text: string | undefined): EvaluationContext {
  if (text === undefined) return {};
  const value = parseJson(text, '--context');
  if (!isContext(value)) throw new UsageError('--context must be a JSON object');
  return value;
}

function isContext(value: unknown): value is EvaluationContext {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
