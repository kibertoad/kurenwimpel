import { Buffer } from 'node:buffer';

import { parseRuleset } from '@kurenwimpel/core';
import type { FlagParseIssue } from '@kurenwimpel/core';

import type { PublishTarget } from '../targets/target.js';
import { PayloadTooLargeError } from './payload-too-large-error.js';
import { revisionOf } from './revision.js';
import { RulesetIssuesError } from './ruleset-issues-error.js';

export interface PublishOptions {
  /** Publish a document with parse issues. Clients drop the invalid definitions and load the rest. */
  readonly allowIssues?: boolean;
  /** Stamps `publishedAt` on the stored revision. Defaults to the system clock. */
  readonly now?: () => Date;
}

export interface PublishResult {
  /** `unchanged` when the target already serves this revision; nothing was written. */
  readonly status: 'published' | 'unchanged';
  readonly revision: string;
  /** What the target served before, `undefined` on a first publish. */
  readonly previousRevision: string | undefined;
  /** Size of the canonical JSON written. */
  readonly bytes: number;
  /** Empty unless `allowIssues` let a document with issues through. */
  readonly issues: readonly FlagParseIssue[];
  readonly target: string;
}

/**
 * Publishes a ruleset document to a target.
 *
 * Refuses a document with parse issues unless `allowIssues` is set, checks the
 * payload against the target's size limit, and writes nothing when the target
 * already serves the same revision. The revision is the SHA-256 of the
 * document's canonical JSON, which is also what gets written.
 */
export async function publishRuleset(
  target: PublishTarget,
  document: unknown,
  options: PublishOptions = {},
): Promise<PublishResult> {
  const { issues } = parseRuleset(document);
  if (issues.length > 0 && options.allowIssues !== true) throw new RulesetIssuesError(issues);

  const { revision, payload } = revisionOf(document);
  const bytes = Buffer.byteLength(payload, 'utf8');
  if (bytes > target.maxPayloadBytes) {
    throw new PayloadTooLargeError(bytes, target.maxPayloadBytes, target.description);
  }

  const previousRevision = await target.currentRevision();
  const result = { revision, previousRevision, bytes, issues, target: target.description };
  if (previousRevision === revision) return { status: 'unchanged', ...result };

  const now = options.now ?? ((): Date => new Date());
  await target.write({ revision, payload, publishedAt: now().toISOString() });
  return { status: 'published', ...result };
}
