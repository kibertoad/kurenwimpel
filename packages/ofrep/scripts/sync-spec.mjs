#!/usr/bin/env node
/**
 * Vendors the upstream OFREP specification documents into `spec/`, or checks the
 * vendored copies against upstream.
 *
 *   node scripts/sync-spec.mjs              # refresh from open-feature/protocol@main
 *   node scripts/sync-spec.mjs --ref=<sha>  # pin to a specific commit, branch or tag
 *   node scripts/sync-spec.mjs --check      # report drift, write nothing
 *
 * `--check` is the drift alarm. The protocol repository publishes no tags, no
 * releases and no npm package, so a branch is the only thing there is to track
 * and a checksum comparison is the only way to notice it moved.
 *
 * Nothing here validates the documents — that is `test/spec-*.test.ts`, which
 * reads the vendored copies offline. This script only moves bytes and records
 * where they came from.
 */

import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const REPOSITORY = 'open-feature/protocol';
const DEFAULT_REF = 'main';

/** The upstream files this package is a transcription of. */
const SPEC_FILES = [
  { path: 'openapi.yaml', upstreamPath: 'service/openapi.yaml' },
  { path: 'event-streams.yaml', upstreamPath: 'service/event-streams.yaml' },
];

const SPEC_DIR = fileURLToPath(new URL('../spec/', import.meta.url));
const PROVENANCE_FILE = path.join(SPEC_DIR, 'provenance.json');

const UPDATE_COMMAND = 'pnpm --filter @kurenwimpel/ofrep run spec:sync';

const sha256 = (contents) => createHash('sha256').update(contents).digest('hex');

const parseArgs = (argv) => {
  const ref = argv.find((arg) => arg.startsWith('--ref='))?.slice('--ref='.length);
  // `--` is what a `pnpm run … -- --ref=x` invocation forwards verbatim.
  const unknown = argv.filter(
    (arg) => !['--', '--check'].includes(arg) && !arg.startsWith('--ref='),
  );

  if (unknown.length > 0) {
    throw new Error(`Unrecognised argument(s): ${unknown.join(', ')}`);
  }
  if (ref !== undefined && ref.length === 0) {
    throw new Error('--ref= needs a commit, branch or tag');
  }

  return { check: argv.includes('--check'), ref: ref ?? DEFAULT_REF };
};

const request = async (url, accept, allowMissing = false) => {
  // GitHub rejects unattributed API requests; raw.githubusercontent.com does not
  // care but is sent the same header for consistency.
  const response = await fetch(url, {
    headers: { accept, 'user-agent': `${REPOSITORY}-spec-sync` },
  });

  if (response.status === 404 && allowMissing) return;

  if (!response.ok) {
    throw new Error(`GET ${url} → ${response.status} ${response.statusText}`);
  }

  return response;
};

/**
 * Resolves a ref to the commit it currently points at, so that the download
 * below is reproducible even if `main` moves between the two calls.
 */
const resolveCommit = async (ref) => {
  const url = `https://api.github.com/repos/${REPOSITORY}/commits/${ref}`;
  const commit = await (await request(url, 'application/vnd.github+json')).json();

  return { sha: commit.sha, date: commit.commit.committer.date };
};

/**
 * With `allowMissing`, a file the ref does not have comes back as `undefined`
 * rather than throwing — upstream renaming or deleting a document is drift to
 * report, not a crash.
 */
const downloadAtCommit = async (sha, upstreamPath, allowMissing = false) => {
  const url = `https://raw.githubusercontent.com/${REPOSITORY}/${sha}/${upstreamPath}`;
  const response = await request(url, 'text/plain', allowMissing);

  // Bytes, not text: the checksum is of what lands on disk, and re-encoding is
  // one more thing that could quietly change it.
  return response && Buffer.from(await response.arrayBuffer());
};

const readVendored = async (file) => {
  try {
    return await readFile(path.join(SPEC_DIR, file.path));
  } catch {
    // Not vendored yet, or removed by hand. Both are drift, and both read as
    // `undefined` to the comparison below.
  }
};

const vendorFile = async (sha, file) => {
  const contents = await downloadAtCommit(sha, file.upstreamPath);
  await writeFile(path.join(SPEC_DIR, file.path), contents);
  console.log(`vendored ${file.upstreamPath} → spec/${file.path} (${contents.byteLength} bytes)`);

  return {
    path: file.path,
    upstreamPath: file.upstreamPath,
    bytes: contents.byteLength,
    sha256: sha256(contents),
  };
};

const sync = async (ref) => {
  const commit = await resolveCommit(ref);

  await mkdir(SPEC_DIR, { recursive: true });
  const files = await Promise.all(SPEC_FILES.map((file) => vendorFile(commit.sha, file)));

  const provenance = {
    $comment: `Written by scripts/sync-spec.mjs. Refresh with \`${UPDATE_COMMAND}\`; see spec/README.md.`,
    repository: `https://github.com/${REPOSITORY}`,
    ref,
    commit: commit.sha,
    commitDate: commit.date,
    retrievedAt: new Date().toISOString(),
    files,
  };

  await writeFile(PROVENANCE_FILE, `${JSON.stringify(provenance, undefined, 2)}\n`);
  console.log(`pinned to ${REPOSITORY}@${commit.sha} (${commit.date})`);
};

const compareFile = async (sha, file) => {
  const [upstream, vendored] = await Promise.all([
    downloadAtCommit(sha, file.upstreamPath, true),
    readVendored(file),
  ]);

  if (upstream !== undefined && vendored !== undefined && upstream.equals(vendored)) {
    return;
  }

  return {
    file,
    upstream: upstream && sha256(upstream),
    vendored: vendored && sha256(vendored),
  };
};

const check = async (ref) => {
  const commit = await resolveCommit(ref);
  const compared = await Promise.all(SPEC_FILES.map((file) => compareFile(commit.sha, file)));
  const drifted = compared.filter((result) => result !== undefined);

  if (drifted.length === 0) {
    console.log(`spec/ is up to date with ${REPOSITORY}@${commit.sha} (${ref})`);
    return;
  }

  console.error(`The upstream OFREP specification has changed (${ref} is now ${commit.sha}):\n`);
  for (const { file, upstream, vendored } of drifted) {
    console.error(`  ${file.upstreamPath}`);
    console.error(`    vendored: ${vendored ?? '(missing)'}`);
    console.error(`    upstream: ${upstream ?? '(missing — renamed or removed upstream)'}`);
  }
  console.error(`\nUpdate the vendored copies and reconcile the contract with:\n`);
  console.error(`  ${UPDATE_COMMAND}`);
  console.error(`  pnpm --filter @kurenwimpel/ofrep test\n`);
  console.error('Failing tests name every place the contract no longer matches the document.');
  process.exitCode = 1;
};

const { check: checkOnly, ref } = parseArgs(process.argv.slice(2));

if (checkOnly) {
  await check(ref);
} else {
  await sync(ref);
}
