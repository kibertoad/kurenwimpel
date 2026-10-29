/**
 * @kurenwimpel/ofrep-server: the OFREP evaluation routes over the Fetch API,
 * backed by a `FeatureFlagClient` and checked against `@kurenwimpel/ofrep`.
 */

export { createOfrepHandler } from './handler.js';
export type {
  OfrepAuthorization,
  OfrepEventStreamOptions,
  OfrepHandler,
  OfrepHandlerOptions,
  OfrepRejection,
} from './options.js';
export {
  DEFAULT_EVENT_STREAM_PATH,
  DEFAULT_HEARTBEAT_INTERVAL_MS,
  DEFAULT_VERSION_CHECK_INTERVAL_MS,
} from './stream-route.js';
