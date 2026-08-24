/**
 * Change-notification transport (ADR-0008): the `eventStreams` entries a bulk
 * response may advertise, and the Server-Sent Event a provider then receives on
 * one of them.
 *
 * Nothing here is required of an OFREP server. A response without `eventStreams`
 * tells the provider to keep polling; the stream is the opt-in fast path.
 */

import * as z from 'zod/mini';

/** The only `eventStream.type` the protocol currently defines. */
export const SSE_EVENT_STREAM_TYPE = 'sse';

/** The only `sseEventData.type` the protocol currently defines. */
export const REFETCH_EVALUATION_EVENT_TYPE = 'refetchEvaluation';

/** Fallback for `inactivityDelaySec` when a stream entry omits it. */
export const DEFAULT_INACTIVITY_DELAY_SECONDS = 120;

const inactivityDelaySchema = z.int().check(z.minimum(1));

/**
 * `components/schemas/eventStreamEndpoint` — the split form, for deployments
 * that override the origin while keeping the request target. The connection URL
 * is `origin + requestUri`, falling back to the configured OFREP base URL's
 * origin when `origin` is absent.
 */
export const eventStreamEndpointSchema = z.looseObject({
  origin: z.optional(z.url()),
  requestUri: z.string().check(z.startsWith('/')),
});

export type OfrepEventStreamEndpoint = z.infer<typeof eventStreamEndpointSchema>;

/**
 * The `url` arm of `eventStream`. Treat the value as a credential: it may embed
 * tokens or channel identifiers, and the spec forbids logging or persisting it.
 */
export const urlEventStreamSchema = z.looseObject({
  type: z.string(),
  url: z.url(),
  endpoint: z.optional(z.never()),
  inactivityDelaySec: z.optional(inactivityDelaySchema),
});

/** The `endpoint` arm of `eventStream`. */
export const endpointEventStreamSchema = z.looseObject({
  type: z.string(),
  endpoint: eventStreamEndpointSchema,
  url: z.optional(z.never()),
  inactivityDelaySec: z.optional(inactivityDelaySchema),
});

/**
 * `components/schemas/eventStream`.
 *
 * The spec's `oneOf` requires exactly one of `url` and `endpoint`; the arm that
 * does not carry a field declares it `optional(never())` so that supplying both
 * fails instead of quietly matching the first arm.
 *
 * `type` stays an open `string`, not an enum of `'sse'`: providers are required
 * to *ignore* entries whose type they do not know, which they can only do if
 * parsing kept them.
 */
export const eventStreamSchema = z.union([urlEventStreamSchema, endpointEventStreamSchema]);

export type OfrepEventStream = z.infer<typeof eventStreamSchema>;

/**
 * A flag-configuration timestamp: Unix seconds (recommended) or an ISO 8601
 * date-time. Shared by `sseEventData.lastModified` and the
 * `flagConfigLastModified` query parameter it feeds.
 */
export const flagConfigLastModifiedSchema = z.union([
  z.int().check(z.minimum(0)),
  z.iso.datetime(),
]);

export type FlagConfigLastModified = z.infer<typeof flagConfigLastModifiedSchema>;

/**
 * `components/schemas/sseEventData` — the JSON payload inside an event's `data`
 * string. Providers route on this `type`, never on the SSE `event` field.
 */
export const sseEventDataSchema = z.looseObject({
  type: z.string(),
  etag: z.optional(z.string()),
  lastModified: z.optional(flagConfigLastModifiedSchema),
});

export type OfrepSseEventData = z.infer<typeof sseEventDataSchema>;

/**
 * `components/schemas/sseEvent` — one event off the stream. `data` is a JSON
 * *string*, so validating it means parsing `data` and running the result through
 * {@link sseEventDataSchema}; the two are deliberately separate schemas.
 */
export const sseEventSchema = z.looseObject({
  data: z.string(),
  event: z.optional(z.string()),
  id: z.optional(z.string()),
  retry: z.optional(z.int().check(z.minimum(0))),
});

export type OfrepSseEvent = z.infer<typeof sseEventSchema>;
