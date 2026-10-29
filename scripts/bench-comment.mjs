// Turns the log of `pnpm run bench --ui=stream` into the markdown body of the
// sticky PR comment. Usage: node scripts/bench-comment.mjs <bench.log>
import { readFileSync } from 'node:fs';
import { cpus, totalmem } from 'node:os';
import { stripVTControlCharacters } from 'node:util';

// The bench job in ci.yml finds the comment to update by this marker.
const MARKER = '<!-- kurenwimpel-bench -->';

const TURBO_PREFIX = /^@kurenwimpel\/(?<pkg>[\w-]+):bench: ?/u;
const KEEP = [/^\s*✓ /u, /^\s+name\s/u, /^\s+· /u, /^(?:retained|allocated) heap \|/u];

function sections(log) {
  const byPackage = new Map();
  for (const rawLine of stripVTControlCharacters(log).split(/\r?\n/u)) {
    const match = TURBO_PREFIX.exec(rawLine);
    if (match === null) continue;
    const line = rawLine.slice(match[0].length);
    if (!KEEP.some((pattern) => pattern.test(line))) continue;
    const lines = byPackage.get(match.groups.pkg) ?? [];
    lines.push(line.replace(/^\s*✓ /u, '\n'));
    byPackage.set(match.groups.pkg, lines);
  }
  return byPackage;
}

const [logPath] = process.argv.slice(2);
if (logPath === undefined) throw new Error('Usage: node scripts/bench-comment.mjs <bench.log>');

const body = [
  MARKER,
  '### Benchmarks',
  '',
  `Commit ${process.env.GITHUB_SHA ?? 'local'} on ${cpus()[0]?.model ?? 'unknown CPU'}, ` +
    `${cpus().length} cores, ${(totalmem() / 2 ** 30).toFixed(0)} GiB, Node ${process.version}.`,
  'Shared runners are noisy: read these as a trend, not a gate. Times are in milliseconds.',
];
for (const [pkg, lines] of sections(readFileSync(logPath, 'utf8'))) {
  const table = lines.map((line) => line.trimEnd()).join('\n');
  body.push('', `#### @kurenwimpel/${pkg}`, '', '```', table.trim(), '```');
}
console.log(body.join('\n'));
