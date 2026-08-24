/**
 * Change-notification transport (ADR-0008): the `eventStreams` entries a bulk
 * response may advertise, and the Server-Sent Event a provider then receives on
 * one of them.
 *
 * Nothing here is required of an OFREP server. A response without `eventStreams`
 * tells the provider to keep polling; the stream is the opt-in fast path.
 */

import type { InferOutput } from 'valibot';
import {
  integer,
  isoTimestamp,
  looseObject,
  minValue,
  never,
  number,
  optional,
  pipe,
  startsWith,
  string,
  union,
  url,
} from 'valibot';

/** The only `eventStream.type` the protocol currently defines. */
export const SSE_EVENT_STREAM_TYPE = 'sse';

/** The only `sseEventData.type` the protocol currently defines. */
export const REFETCH_EVALUATION_EVENT_TYPE = 'refetchEvaluation';

/** Fallback for `inactivityDelaySec` when a stream entry omits it. */
export const DEFAULT_INACTIVITY_DELAY_SECONDS = 120;

const inactivityDelaySchema = pipe(number(), integer(), minValue(1));

/**
 * `components/schemas/eventStreamEndpoint` — the split form, for deployments
 * that override the origin while keeping the request target. The connection URL
 * is `origin + requestUri`, falling back to the configured OFREP base URL's
 * origin when `origin` is absent.
 */
export const eventStreamEndpointSchema = looseObject({
  origin: optional(pipe(string(), url())),
  requestUri: pipe(string(), startsWith('/')),
});

export type OfrepEventStreamEndpoint = InferOutput<typeof eventStreamEndpointSchema>;

/**
 * The `url` arm of `eventStream`. Treat the value as a credential: it may embed
 * tokens or channel identifiers, and the spec forbids logging or persisting it.
 */
export const urlEventStreamSchema = looseObject({
  type: string(),
  url: pipe(string(), url()),
  endpoint: optional(never()),
  inactivityDelaySec: optional(inactivityDelaySchema),
});

/** The `endpoint` arm of `eventStream`. */
export const endpointEventStreamSchema = looseObject({
  type: string(),
  endpoint: eventStreamEndpointSchema,
  url: optional(never()),
  inactivityDelaySec: optional(inactivityDelaySchema),
});

/**
 * `components/schemas/eventStream`.
 *
 * The spec's `oneOf` requires exactly one of `url` and `endpoint`; the arm that
 * does not carry a field declares it `optional(never())` so that supplying both
 * fails instead of quietly matching the first arm.
 *
 * `type` stays an open `string`, not a picklist of `'sse'`: providers are
 * required to *ignore* entries whose type they do not know, which they can only
 * do if parsing kept them.
 */
export const eventStreamSchema = union([urlEventStreamSchema, endpointEventStreamSchema]);

export type OfrepEventStream = InferOutput<typeof eventStreamSchema>;

/**
 * A flag-configuration timestamp: Unix seconds (recommended) or an ISO 8601
 * date-time. Shared by `sseEventData.lastModified` and the `flagConfigLastModified`
 * query parameter it feeds.
 */
export const flagConfigLastModifiedSchema = union([
  pipe(number(), integer(), minValue(0)),
  pipe(string(), isoTimestamp()),
]);

export type FlagConfigLastModified = InferOutput<typeof flagConfigLastModifiedSchema>;

/**
 * `components/schemas/sseEventData` — the JSON payload inside an event's `data`
 * string. Providers route on this `type`, never on the SSE `event` field.
 */
export const sseEventDataSchema = looseObject({
  type: string(),
  etag: optional(string()),
  lastModified: optional(flagConfigLastModifiedSchema),
});

export type OfrepSseEventData = InferOutput<typeof sseEventDataSchema>;

/**
 * `components/schemas/sseEvent` — one event off the stream. `data` is a JSON
 * *string*, so validating it means parsing `data` and running the result through
 * {@link sseEventDataSchema}; the two are deliberately separate schemas.
 */
export const sseEventSchema = looseObject({
  data: string(),
  event: optional(string()),
  id: optional(string()),
  retry: optional(pipe(number(), integer(), minValue(0))),
});

export type OfrepSseEvent = InferOutput<typeof sseEventSchema>;
