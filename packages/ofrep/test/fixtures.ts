/**
 * Payloads copied verbatim from the `examples` of the OFREP 0.3.0 OpenAPI
 * document (open-feature/protocol, `service/openapi.yaml`).
 *
 * They exist so the contract is checked against what a server implementer will
 * actually have copied, rather than only against the schemas' own reading of the
 * document.
 */

export const SINGLE_EVALUATION_REQUEST = {
  context: {
    targetingKey: 'user-123',
    email: 'user@example.com',
    'custom-plan': 'premium',
    country: 'CA',
  },
};

export const SINGLE_EVALUATION_SUCCESS = {
  key: 'discount-banner',
  value: true,
  reason: 'TARGETING_MATCH',
  variant: 'enabled',
};

export const SINGLE_EVALUATION_FAILURE = {
  key: 'my-flag',
  errorCode: 'INVALID_CONTEXT',
  errorDetails: 'Context is missing required targetingKey property',
};

export const FLAG_NOT_FOUND = {
  key: 'non-existent-flag',
  errorCode: 'FLAG_NOT_FOUND',
  errorDetails: "Flag 'non-existent-flag' was not found",
};

export const GENERAL_ERROR = {
  errorDetails: 'An internal server error occurred while processing the request',
};

export const BULK_EVALUATION_REQUEST = {
  context: {
    targetingKey: 'user-456',
    email: 'user@example.com',
    plan: 'free',
    country: 'CA',
  },
};

export const BULK_EVALUATION_SUCCESS = {
  flags: [
    { key: 'discount-banner', value: true, reason: 'TARGETING_MATCH', variant: 'enabled' },
    { key: 'theme-color', value: 'blue', reason: 'STATIC', variant: 'default' },
    {
      key: 'non-existent-flag',
      errorCode: 'FLAG_NOT_FOUND',
      errorDetails: "Flag 'non-existent-flag' was not found",
    },
  ],
  eventStreams: [
    {
      type: 'sse',
      url: 'https://sse.example.com/event-stream?channels=env_abc123_v1',
      inactivityDelaySec: 120,
    },
  ],
  metadata: { version: 'v12' },
};

export const BULK_EVALUATION_FAILURE = {
  errorCode: 'INVALID_CONTEXT',
  errorDetails: 'Context is missing required targetingKey property',
};

export const EVENT_STREAM_ENDPOINT = {
  origin: 'https://sse.example.com',
  requestUri: '/event-stream?channels=env_abc123_v1',
};
