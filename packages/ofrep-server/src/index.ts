/**
 * @kurenwimpel/ofrep-server: the OFREP evaluation routes over the Fetch API,
 * backed by a `FeatureFlagClient` and checked against `@kurenwimpel/ofrep`.
 */

export { createOfrepHandler } from './handler.js';
export type {
  OfrepAuthorization,
  OfrepHandler,
  OfrepHandlerOptions,
  OfrepRejection,
} from './options.js';
