/**
 * @kurenwimpel/openfeature: OpenFeature server provider.
 *
 * Wraps a `FeatureFlagClient` from `@kurenwimpel/core`, `@kurenwimpel/node` or
 * `@kurenwimpel/cloudflare`, so call sites can code against the OpenFeature API.
 */

export { toEngineContext } from './context.js';
export { KurenwimpelProvider } from './provider.js';
export { toOpenFeatureErrorCode, toOpenFeatureReason, toResolutionDetails } from './resolution.js';
