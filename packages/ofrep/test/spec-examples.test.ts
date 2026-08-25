/**
 * Every example payload in the vendored document, parsed by the schema that
 * would have to accept it on the wire.
 *
 * Examples are what a server implementer copies, so they are the part of the
 * document most likely to expose a shape the prose left out — and the part the
 * document's own schemas do not have to agree with (the bulk example returns a
 * `FLAG_NOT_FOUND` entry its `oneOf` cannot produce; see `contracts.ts`).
 * Checking them is how that disagreement was found in the first place.
 */

import { describe, expect, it } from 'vitest';
import * as z from 'zod/mini';

import {
  bulkEvaluationQuerySchema,
  bulkEvaluationRequestHeadersSchema,
  evaluateFlagContract,
  evaluateFlagPathParamsSchema,
  evaluateFlagsBulkContract,
  ofrepResponseHeadersSchema,
  REFETCH_EVALUATION_EVENT_TYPE,
  sseEventDataSchema,
  sseEventSchema,
} from '../src/index.js';
import { componentNameOf, schemaForComponent } from './component-registry.js';
import {
  BULK_EVALUATION_FAILURE,
  BULK_EVALUATION_REQUEST,
  BULK_EVALUATION_SUCCESS,
  EVENT_STREAM_ENDPOINT,
  FLAG_NOT_FOUND,
  GENERAL_ERROR,
  SINGLE_EVALUATION_FAILURE,
  SINGLE_EVALUATION_REQUEST,
  SINGLE_EVALUATION_SUCCESS,
} from './fixtures.js';
import { componentSchemas, deref, openapiDocument, specOperations } from './openapi-document.js';

type Node = any;

type Example = { label: string; value: unknown; schema: unknown };

/** `example`, `examples: {name: {value}}`, and the same two inside a `schema`. */
const examplesOf = (node: Node): { label: string; value: unknown }[] => {
  if (node === undefined || node === null) return [];

  return [
    ...(node.example === undefined ? [] : [{ label: 'example', value: node.example }]),
    ...Object.entries<Node>(node.examples ?? {}).map(([label, example]) => ({
      label,
      value: example.value,
    })),
    ...examplesOf(node.schema),
  ];
};

const at = (label: string, node: Node, schema: unknown): Example[] =>
  examplesOf(node).map((example) => ({
    label: `${label} (${example.label})`,
    value: example.value,
    schema,
  }));

const jsonBody = (node: Node): Node => node?.content?.['application/json'];

/** The schema a `$ref`-ed body is transcribed as here. */
const schemaOfBody = (body: Node): unknown => schemaForComponent(componentNameOf(body.schema.$ref));

const bodyExamples = (): Example[] =>
  specOperations().flatMap(({ id, operation }) => {
    const request = jsonBody(operation.requestBody);
    const responses = Object.entries<Node>(operation.responses)
      .map(([status, response]): [string, Node] => [status, jsonBody(response)])
      .filter(([, body]) => body !== undefined);

    return at(`${id} request`, request, schemaOfBody(request)).concat(
      responses.flatMap(([status, body]) => at(`${id} → ${status}`, body, schemaOfBody(body))),
    );
  });

/**
 * Parameters and response headers, wrapped into the single-key object their
 * schema describes. The wrapping is the test: `flagConfigLastModified` travels
 * on a query string that cannot carry the number the document shows there.
 */
const outsideBodyExamples = (): Example[] => {
  const schemasByLocation: Record<string, Record<string, unknown>> = {
    'post /ofrep/v1/evaluate/flags/{key}': {
      path: evaluateFlagPathParamsSchema,
      header: bulkEvaluationRequestHeadersSchema,
    },
    'post /ofrep/v1/evaluate/flags': {
      query: bulkEvaluationQuerySchema,
      header: bulkEvaluationRequestHeadersSchema,
    },
  };

  return specOperations().flatMap(({ id, operation }) => {
    const parameters = (operation.parameters ?? []).map((parameter: Node) => deref(parameter));
    const headers = Object.entries<Node>(operation.responses).flatMap(([status, response]) =>
      Object.entries<Node>(response.headers ?? {}).map(([name, header]) => ({
        label: `${id} → ${status} ${name}`,
        name: name.toLowerCase(),
        node: header,
        schema: ofrepResponseHeadersSchema,
      })),
    );

    return parameters
      .map((parameter: Node) => ({
        label: `${id} ${parameter.in} ${parameter.name}`,
        name: parameter.in === 'header' ? parameter.name.toLowerCase() : parameter.name,
        node: parameter,
        schema: schemasByLocation[id]?.[parameter.in],
      }))
      .concat(headers)
      .flatMap(({ label, name, node, schema }: Node) =>
        at(label, node, schema).map((example) => ({
          label: example.label,
          schema: example.schema,
          value: { [name as string]: example.value },
        })),
      );
  });
};

const componentExamples = (): Example[] =>
  Object.keys(componentSchemas)
    .filter((name) => schemaForComponent(name) !== undefined)
    .flatMap((name) => at(name, componentSchemas[name], schemaForComponent(name)));

const examples = [...bodyExamples(), ...outsideBodyExamples(), ...componentExamples()];

describe('the examples in the document', () => {
  it('are found where this test expects them', () => {
    // Guards the loops below against silently iterating nothing.
    expect(examples.length).toBeGreaterThan(15);
    expect(examples.every((example) => example.schema !== undefined)).toBe(true);
  });

  it.each(examples)('$label parses', ({ value, schema }) => {
    const result = z.safeParse(schema as never, value);
    expect(result.error?.issues ?? []).toEqual([]);
  });
});

describe('the fixtures the rest of the suite parses', () => {
  const single = openapiDocument.paths['/ofrep/v1/evaluate/flags/{key}'].post;
  const bulk = openapiDocument.paths['/ofrep/v1/evaluate/flags'].post;
  const endpointProperties = componentSchemas['eventStreamEndpoint'].properties;

  it.each([
    ['SINGLE_EVALUATION_REQUEST', SINGLE_EVALUATION_REQUEST, jsonBody(single.requestBody)],
    ['SINGLE_EVALUATION_SUCCESS', SINGLE_EVALUATION_SUCCESS, jsonBody(single.responses['200'])],
    ['SINGLE_EVALUATION_FAILURE', SINGLE_EVALUATION_FAILURE, jsonBody(single.responses['400'])],
    ['FLAG_NOT_FOUND', FLAG_NOT_FOUND, jsonBody(single.responses['404'])],
    ['GENERAL_ERROR', GENERAL_ERROR, jsonBody(single.responses['500'])],
    ['BULK_EVALUATION_REQUEST', BULK_EVALUATION_REQUEST, jsonBody(bulk.requestBody)],
    ['BULK_EVALUATION_SUCCESS', BULK_EVALUATION_SUCCESS, jsonBody(bulk.responses['200'])],
    ['BULK_EVALUATION_FAILURE', BULK_EVALUATION_FAILURE, jsonBody(bulk.responses['400'])],
  ])('%s is the document example verbatim', (_name, fixture, body: Node) => {
    expect(fixture).toEqual(body.example);
  });

  it('EVENT_STREAM_ENDPOINT is assembled from the two property examples', () => {
    expect(EVENT_STREAM_ENDPOINT).toEqual({
      origin: endpointProperties.origin.example,
      requestUri: endpointProperties.requestUri.example,
    });
  });
});

describe('the SSE payload the document only describes in prose', () => {
  it('parses as the event data schema once the `data` string is parsed', () => {
    // `sseEvent.data` is a JSON *string*, so the document cannot carry a usable
    // example of the payload; `sseEventData`'s property examples are the closest
    // thing to one, and assembling them is the work a provider has to do on
    // every event. `z.parse` rather than `safeParse`: a throw is the failure.
    const properties = componentSchemas['sseEventData'].properties;
    const event = z.parse(sseEventSchema, {
      event: 'message',
      data: JSON.stringify({
        type: properties.type.example,
        etag: properties.etag.example,
        lastModified: properties.lastModified.example,
      }),
    });

    const data = z.parse(sseEventDataSchema, JSON.parse(event.data));

    expect(data.type).toBe(REFETCH_EVALUATION_EVENT_TYPE);
  });
});

describe('the contracts the examples travel through', () => {
  it('accept the document request bodies through the contract, not only the schema', () => {
    // `bodyExamples` above resolves the schema by `$ref` name; these two go
    // through the contract slot a client would actually reach for.
    const single = jsonBody(
      openapiDocument.paths['/ofrep/v1/evaluate/flags/{key}'].post.requestBody,
    );
    const bulk = jsonBody(openapiDocument.paths['/ofrep/v1/evaluate/flags'].post.requestBody);

    expect(z.safeParse(evaluateFlagContract.requestBodySchema, single.example).success).toBe(true);
    expect(z.safeParse(evaluateFlagsBulkContract.requestBodySchema, bulk.example).success).toBe(
      true,
    );
  });
});
