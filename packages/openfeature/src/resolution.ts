import { toOfrepErrorCode, toOfrepReason } from '@kurenwimpel/core';
import type {
  EvaluationErrorCode,
  EvaluationReason,
  FlagValue,
  OfrepErrorCode,
  ResolvedEvaluation,
} from '@kurenwimpel/core';
import { ErrorCode, StandardResolutionReasons } from '@openfeature/server-sdk';
import type { ResolutionDetails, ResolutionReason } from '@openfeature/server-sdk';

const FROM_OFREP: Readonly<Record<OfrepErrorCode, ErrorCode>> = {
  PARSE_ERROR: ErrorCode.PARSE_ERROR,
  TARGETING_KEY_MISSING: ErrorCode.TARGETING_KEY_MISSING,
  INVALID_CONTEXT: ErrorCode.INVALID_CONTEXT,
  GENERAL: ErrorCode.GENERAL,
  FLAG_NOT_FOUND: ErrorCode.FLAG_NOT_FOUND,
};

/** The OFREP reason, which OpenFeature shares, or `ERROR` for a failed evaluation. */
export function toOpenFeatureReason(reason: EvaluationReason): ResolutionReason {
  return toOfrepReason(reason) ?? StandardResolutionReasons.ERROR;
}

/**
 * The OFREP error code, except where OpenFeature has a closer one: OFREP
 * folds `PROVIDER_NOT_READY` and `TYPE_MISMATCH` into `GENERAL`.
 */
export function toOpenFeatureErrorCode(code: EvaluationErrorCode): ErrorCode {
  switch (code) {
    case 'PROVIDER_NOT_READY': {
      return ErrorCode.PROVIDER_NOT_READY;
    }
    case 'TYPE_MISMATCH': {
      return ErrorCode.TYPE_MISMATCH;
    }
    case 'FLAG_NOT_FOUND':
    case 'INVALID_DEFINITION':
    case 'TARGETING_KEY_MISSING':
    case 'VARIANT_NOT_FOUND': {
      return FROM_OFREP[toOfrepErrorCode(code)];
    }
  }
}

/** Maps a client result onto OpenFeature's shape, serving `value`. */
export function toResolutionDetails<T>(
  result: ResolvedEvaluation<FlagValue>,
  value: T,
): ResolutionDetails<T> {
  return {
    value,
    reason: toOpenFeatureReason(result.reason),
    ...(result.variant === undefined ? {} : { variant: result.variant }),
    ...(result.errorCode === undefined
      ? {}
      : { errorCode: toOpenFeatureErrorCode(result.errorCode) }),
    ...(result.errorMessage === undefined ? {} : { errorMessage: result.errorMessage }),
    ...(result.metadata === undefined ? {} : { flagMetadata: result.metadata }),
  };
}
