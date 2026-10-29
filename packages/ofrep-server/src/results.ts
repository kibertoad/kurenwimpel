import { toOfrepErrorCode, toOfrepReason } from '@kurenwimpel/core';
import type {
  EvaluationResult,
  FlagMetadata,
  FlagValue,
  OfrepErrorCode,
  OfrepReason,
} from '@kurenwimpel/core';

export interface OfrepSuccessBody {
  readonly key: string;
  readonly reason: OfrepReason;
  readonly value?: FlagValue;
  readonly variant?: string;
  readonly metadata?: FlagMetadata;
}

export interface OfrepFailureBody {
  readonly key: string;
  readonly errorCode: OfrepErrorCode;
  readonly errorDetails?: string;
  readonly metadata?: FlagMetadata;
}

export type OfrepEntry = OfrepSuccessBody | OfrepFailureBody;

/**
 * One evaluation in wire form. Rule ids and failed prerequisites stay on the
 * server: they describe targeting, which OFREP callers have no business reading.
 */
export function toOfrepEntry(result: EvaluationResult): OfrepEntry {
  const { key, metadata } = result;
  const withMetadata = metadata === undefined ? {} : { metadata };
  const reason = toOfrepReason(result.reason);

  if (reason !== undefined && result.errorCode === undefined) {
    return {
      key,
      reason,
      ...(result.value === undefined ? {} : { value: result.value }),
      ...(result.variant === undefined ? {} : { variant: result.variant }),
      ...withMetadata,
    };
  }

  const errorCode = toOfrepErrorCode(result.errorCode ?? 'PROVIDER_NOT_READY');
  const details = result.errorMessage === undefined ? {} : { errorDetails: result.errorMessage };
  // The spec's flagNotFound body has no use for metadata: there is no flag to describe.
  return errorCode === 'FLAG_NOT_FOUND'
    ? { key, errorCode, ...details }
    : { key, errorCode, ...details, ...withMetadata };
}

/** The single-flag route's status for an entry, per the vendored spec. */
export function statusOf(entry: OfrepEntry): 200 | 400 | 404 {
  if ('reason' in entry) return 200;
  return entry.errorCode === 'FLAG_NOT_FOUND' ? 404 : 400;
}
