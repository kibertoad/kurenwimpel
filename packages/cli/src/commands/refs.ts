import { parseRuleset } from '@kurenwimpel/core';

import { ExitCode, FORMAT_OPTION, formatOption, UsageError } from '../command.js';
import type { CliIo, Command, CommandArgs } from '../command.js';
import { renderRefsGithub, renderRefsMarkdown, renderRefsText } from '../format/refs-format.js';
import type { RefsResult } from '../format/refs-format.js';
import { findReferences, isSourceFile } from '../refs/scan.js';
import { messageOf, parseJson, readText, toJson, warnAboutIssues } from '../ruleset-file.js';

export interface RefsReport extends RefsResult {
  readonly sources: readonly string[];
}

export const refsCommand: Command = {
  name: 'refs',
  summary: 'Find flags no code reads, and code reading flags that do not exist.',
  usage: [
    'Usage: kurenwimpel refs <file> --src <dir> [--src <dir>...]',
    '                        [--format text|json|markdown|github]',
    '',
    'Scans JavaScript and TypeScript files for getBoolean, getString, getNumber,',
    'getObject, their Value and Details forms, and evaluate, called with a string',
    'literal key. node_modules and dot directories are skipped. A key built at run',
    'time is not seen, so check an unreferenced flag before removing it.',
    'Exits 1 when a flag is unreferenced or a key is unknown.',
  ].join('\n'),
  options: { ...FORMAT_OPTION, src: { type: 'string', multiple: true } },
  async run(args, io) {
    const format = formatOption(args, ['text', 'json', 'markdown', 'github']);
    const [path, ...extra] = args.positionals;
    if (path === undefined || extra.length > 0) throw new UsageError('expected exactly one file');
    const sources = sourceDirectories(args);

    const text = await readText(io, path);
    const parsed = parseRuleset(parseJson(text, path));
    warnAboutIssues(io, { path, raw: undefined, parsed });
    const files = await sourceFiles(io, sources);
    const references = (
      await Promise.all(files.map(async (file) => findReferences(file, await readText(io, file))))
    ).flat();

    const keys = new Set(parsed.flags.map((flag) => flag.key));
    const used = new Set(references.map((ref) => ref.key));
    const report: RefsReport = {
      file: path,
      sources,
      flags: keys.size,
      files: files.length,
      references,
      unreferenced: [...keys].filter((key) => !used.has(key)),
      unknown: references.filter((ref) => !keys.has(ref.key)),
    };

    io.stdout(render(report, format, text));
    const clean = report.unreferenced.length + report.unknown.length === 0;
    return clean ? ExitCode.Ok : ExitCode.Findings;
  },
};

function sourceDirectories(args: CommandArgs): string[] {
  const value = args.values['src'];
  const list = Array.isArray(value) ? value : [value];
  const directories = list.filter((entry): entry is string => typeof entry === 'string');
  if (directories.length === 0) throw new UsageError('expected --src <dir>');
  return directories;
}

async function sourceFiles(io: CliIo, directories: readonly string[]): Promise<string[]> {
  const listed = await Promise.all(
    directories.map(async (directory) => {
      try {
        return await io.listFiles(directory);
      } catch (error) {
        throw new UsageError(`cannot list ${directory}: ${messageOf(error)}`);
      }
    }),
  );
  return [...new Set(listed.flat())].filter((file) => isSourceFile(file));
}

function render(
  report: RefsReport,
  format: 'text' | 'json' | 'markdown' | 'github',
  text: string,
): string {
  switch (format) {
    case 'github':
      return renderRefsGithub(report, text);
    case 'json':
      return toJson(report);
    case 'markdown':
      return renderRefsMarkdown(report);
    case 'text':
      return renderRefsText(report);
  }
}
