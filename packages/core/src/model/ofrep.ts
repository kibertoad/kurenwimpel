/**
 * The mapping onto the OFREP wire vocabulary.
 *
 * `@kurenwimpel/ofrep` defines the protocol and depends on nothing; this
 * module is the core's side of the handshake, so the server handler that
 * eventually joins the two starts from one canonical mapping instead of
 * inventing its own. Values are spelled as literals rather than imported —
 * the two packages stay independent, and the contract's own tests pin the
 * protocol side.
 */

import type { EvaluationErrorCode, EvaluationReason } from './result.js';

/** The `reason` values OFREP 0.3.0 allows on a successful evaluation. */
export type OfrepReason = 'STATIC' | 'TARGETING_MATCH' | 'SPLIT' | 'DISABLED' | 'UNKNOWN';

/**
 * Error codes an OFREP `evaluationFailure` body can carry. `FLAG_NOT_FOUND`
 * is nominally a 404 body of its own, but the protocol's bulk examples carry
 * it inline, and the contract package follows the examples.
 */
export type OfrepErrorCode =
  | 'PARSE_ERROR'
  | 'TARGETING_KEY_MISSING'
  | 'INVALID_CONTEXT'
  | 'GENERAL'
  | 'FLAG_NOT_FOUND';

/**
 * Maps an evaluation reason onto the OFREP reason enum.
 *
 * Returns `undefined` for `ERROR`: a failed evaluation is not a success body
 * with a reason, it is an `evaluationFailure` — map its code with
 * {@link toOfrepErrorCode} instead.
 *
 * `NOT_ALLOCATED` becomes `STATIC` (the statically configured default was
 * served) and `PREREQUISITE_FAILED` becomes `DISABLED` (a kill switch upstream
 * of the flag closed it) — the nearest truths the protocol can express. The
 * exact reason still travels in `metadata` if the serving layer chooses to put
 * it there.
 */
export function toOfrepReason(reason: EvaluationReason): OfrepReason | undefined {
  switch (reason) {
    case 'STATIC':
    case 'NOT_ALLOCATED': {
      return 'STATIC';
    }
    case 'TARGETING_MATCH': {
      return 'TARGETING_MATCH';
    }
    case 'SPLIT': {
      return 'SPLIT';
    }
    case 'DISABLED':
    case 'PREREQUISITE_FAILED': {
      return 'DISABLED';
    }
    case 'ERROR': {
      return undefined;
    }
  }
}

/**
 * Maps an evaluation error code onto the OFREP failure vocabulary.
 *
 * `TYPE_MISMATCH` maps to `GENERAL` only nominally: OFREP servers never report
 * type mismatches, because the value travels in its natural JSON type and the
 * calling SDK does the comparison. It appears here so the mapping is total.
 */
export function toOfrepErrorCode(code: EvaluationErrorCode): OfrepErrorCode {
  switch (code) {
    case 'FLAG_NOT_FOUND': {
      return 'FLAG_NOT_FOUND';
    }
    case 'INVALID_DEFINITION': {
      return 'PARSE_ERROR';
    }
    case 'TARGETING_KEY_MISSING': {
      return 'TARGETING_KEY_MISSING';
    }
    case 'PROVIDER_NOT_READY':
    case 'VARIANT_NOT_FOUND':
    case 'TYPE_MISMATCH': {
      return 'GENERAL';
    }
  }
}
