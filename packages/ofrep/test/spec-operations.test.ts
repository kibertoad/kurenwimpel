/**
 * The routes in `src/contracts.ts` against the vendored OFREP document: paths,
 * methods, status codes, which schema answers which status, and everything that
 * travels outside the body.
 *
 * Every expectation is read out of `spec/openapi.yaml` rather than written down
 * here — a hand-copied status list is another transcription to keep in step, and
 * `contracts.test.ts` already holds the hand-copied one. The two are
 * complementary on purpose: that file pins what the document said when this
 * package was written, this file pins that it still says it.
 */

import { isNoBodyResponse, mapApiContractToPath } from '@toad-contracts/core';
import { describe, expect, it } from 'vitest';

import {
  evaluateFlagContract,
  evaluateFlagsBulkContract,
  ofrepAuthHeadersSchema,
  ofrepResponseHeadersSchema,
  OFREP_CONTRACTS,
} from '../src/index.js';
import { componentNameOf, schemaForComponent } from './component-registry.js';
import {
  declaredPropertyNames,
  deref,
  openapiDocument,
  specOperations,
} from './openapi-document.js';

type Node = any;

const CONTRACT_BY_OPERATION: Record<string, Node> = {
  'post /ofrep/v1/evaluate/flags/{key}': evaluateFlagContract,
  'post /ofrep/v1/evaluate/flags': evaluateFlagsBulkContract,
};

const operations = specOperations();

const jsonBodyRef = (body: Node): string | undefined =>
  body?.content?.['application/json']?.schema?.$ref;

const parametersIn = (operation: Node, location: string): string[] =>
  (operation.parameters ?? [])
    .map((parameter: Node) => deref(parameter))
    .filter((parameter: Node) => parameter.in === location)
    .map((parameter: Node): string =>
      location === 'header' ? parameter.name.toLowerCase() : parameter.name,
    )
    .toSorted();

const namesOf = (schema: unknown): string[] =>
  schema === undefined ? [] : declaredPropertyNames(schema);

const ascending = (a: number, b: number): number => a - b;

const statusCodes = (responses: Node): number[] =>
  Object.keys(responses).map(Number).toSorted(ascending);

const declaredTagNames = (): string[] => openapiDocument.tags.map((tag: Node): string => tag.name);

describe('operations', () => {
  it('are covered one for one by the exported contracts', () => {
    expect(Object.keys(CONTRACT_BY_OPERATION).toSorted()).toEqual(
      operations.map((operation) => operation.id).toSorted(),
    );
    expect(new Set(Object.values(OFREP_CONTRACTS))).toEqual(
      new Set(Object.values(CONTRACT_BY_OPERATION)),
    );
  });
});

describe.each(operations)('$id', ({ id, path, method, operation }) => {
  const contract = CONTRACT_BY_OPERATION[id];

  it('is served at that path, by that method, under that tag', () => {
    expect(contract.method).toBe(method);
    // `{key}` in OpenAPI is `:key` in a route pattern.
    expect(mapApiContractToPath(contract)).toBe(path.replaceAll(/\{(\w+)\}/gu, ':$1'));
    expect(contract.tags).toEqual(operation.tags);
    for (const tag of contract.tags) expect(declaredTagNames()).toContain(tag);
  });

  it('reads the request body the document declares', () => {
    expect(operation.requestBody.required).toBe(true);
    expect(contract.requestBodySchema).toBe(
      schemaForComponent(componentNameOf(jsonBodyRef(operation.requestBody)!)),
    );
  });

  it('answers exactly the statuses the document declares', () => {
    expect(statusCodes(contract.responsesByStatusCode)).toEqual(statusCodes(operation.responses));
  });

  it('answers each status with the body the document names', () => {
    for (const [status, response] of Object.entries<Node>(operation.responses)) {
      const entry = contract.responsesByStatusCode[Number(status)];
      const ref = jsonBodyRef(response);

      // Identity, not shape: a 400 wired to the 404's schema would describe a
      // perfectly valid body — just not this status's.
      expect(ref === undefined ? isNoBodyResponse(entry) : entry, `${id} → ${status}`).toBe(
        ref === undefined ? true : schemaForComponent(componentNameOf(ref)),
      );
    }
  });

  it('declares every parameter the document declares', () => {
    expect(namesOf(contract.requestPathParamsSchema)).toEqual(parametersIn(operation, 'path'));
    expect(namesOf(contract.requestQuerySchema)).toEqual(parametersIn(operation, 'query'));
    // Headers only need covering, not matching: the two authentication headers
    // are declared under `securitySchemes` rather than as parameters.
    expect(namesOf(contract.requestHeaderSchema)).toEqual(
      expect.arrayContaining(parametersIn(operation, 'header')),
    );
  });
});

describe('headers', () => {
  it('carry a request header for each authentication scheme the document offers', () => {
    const schemes = Object.values<Node>(openapiDocument.components.securitySchemes);
    const names = schemes.map((scheme): string => {
      if (scheme.type === 'apiKey') {
        expect(scheme.in).toBe('header');
        return scheme.name.toLowerCase();
      }
      expect(scheme.type).toBe('http');
      return 'authorization';
    });

    expect(declaredPropertyNames(ofrepAuthHeadersSchema)).toEqual(names.toSorted());
  });

  it('carry every response header the document sets', () => {
    const declared = operations
      .flatMap(({ operation }) => Object.values<Node>(operation.responses))
      .flatMap((response) => Object.keys(response.headers ?? {}))
      .map((name) => name.toLowerCase());

    // Pinned rather than only covered: an upstream-added response header would
    // otherwise pass a subset check by being absent from both sides.
    expect([...new Set(declared)].toSorted()).toEqual(['etag', 'retry-after']);
    expect(declaredPropertyNames(ofrepResponseHeadersSchema)).toEqual(
      expect.arrayContaining([...new Set(declared)]),
    );
  });
});
