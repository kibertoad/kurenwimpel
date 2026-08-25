/**
 * The schemas in `src/` against the vendored OFREP document, component by
 * component.
 *
 * `src/` is a hand transcription, and a transcription's failure mode is not a
 * typo — the tests around it would catch that — it is the document changing
 * underneath it. `spec/` pins the document this package was written from, this
 * file checks the transcription against it, and `pnpm spec:check` reports when
 * upstream has moved on. See `spec/README.md`.
 *
 * These comparisons cover structure: properties, requiredness, types, enum
 * values. They deliberately do not cover the refinements the contract adds on
 * top (`minLength`, `format`, `pattern`), which are checked by the parse tests
 * next door.
 */

import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  bulkEvaluationEntrySchema,
  OFREP_BASE_PATH,
  OFREP_EVALUATE_PATH,
  OFREP_PROTOCOL_VERSION,
} from '../src/index.js';
import { COMPONENT_REGISTRY, componentNameOf, schemaForComponent } from './component-registry.js';
import {
  componentSchemas,
  describeContractSchema,
  describeSpecSchema,
  describeSpecUnion,
  eventStreamsDocument,
  openapiDocument,
  provenance,
  readSpecFile,
} from './openapi-document.js';

describe('the vendored documents', () => {
  it('are the bytes `scripts/sync-spec.mjs` recorded', () => {
    // A checksum in `provenance.json` is the difference between "vendored from
    // upstream" and "vendored from upstream, then edited to make a test pass".
    for (const file of provenance.files) {
      const actual = createHash('sha256').update(readSpecFile(file.path)).digest('hex');
      expect(actual, `spec/${file.path}`).toBe(file.sha256);
    }
  });

  it('record where they came from', () => {
    expect(provenance.repository).toBe('https://github.com/open-feature/protocol');
    expect(provenance.commit).toMatch(/^[0-9a-f]{40}$/u);
    expect(provenance.files.map((file: { path: string }) => file.path)).toEqual([
      'openapi.yaml',
      'event-streams.yaml',
    ]);
  });

  it('are the protocol revision the package claims to transcribe', () => {
    expect(openapiDocument.info.version).toBe(OFREP_PROTOCOL_VERSION);
    expect(eventStreamsDocument.info.version).toBe(OFREP_PROTOCOL_VERSION);
  });

  it('put every route under the base path the package exports', () => {
    const paths = Object.keys(openapiDocument.paths);

    expect(paths).toContain(OFREP_EVALUATE_PATH);
    for (const path of paths) expect(path.startsWith(`${OFREP_BASE_PATH}/`)).toBe(true);
  });
});

describe('component schemas', () => {
  it('are all accounted for', () => {
    // Fails on a component added, renamed or removed upstream — the drift that
    // a per-schema test cannot see, because it never runs for a schema nobody
    // thought to write a test for.
    expect(Object.keys(COMPONENT_REGISTRY).toSorted()).toEqual(
      Object.keys(componentSchemas).toSorted(),
    );
  });

  const modelled = Object.keys(COMPONENT_REGISTRY).filter(
    (name) => schemaForComponent(name) !== undefined,
  );

  it.each(modelled)('%s is transcribed with the shape the document declares', (name) => {
    expect(describeContractSchema(schemaForComponent(name))).toEqual(
      describeSpecSchema(componentSchemas[name]),
    );
  });
});

describe('the one deviation the shapes cannot express', () => {
  const flagsItems = componentSchemas['bulkEvaluationSuccess'].properties.flags.items;

  it('leaves `flagNotFound` out of the document bulk flags array', () => {
    // Pinned so the deviation below stays a deviation from a known baseline: if
    // upstream fixes its own `oneOf` (open-feature/protocol lists FLAG_NOT_FOUND
    // in neither arm, yet returns it in the example), this is the test that says
    // the extra arm is no longer an addition.
    expect(flagsItems.oneOf.map((arm: { $ref: string }) => componentNameOf(arm.$ref))).toEqual([
      'evaluationSuccess',
      'evaluationFailure',
    ]);
  });

  it('accepts those two arms plus `flagNotFound`', () => {
    const withNotFound = ['evaluationSuccess', 'evaluationFailure', 'flagNotFound'].map(
      (name) => componentSchemas[name],
    );

    expect(describeContractSchema(bulkEvaluationEntrySchema)).toEqual(
      describeSpecUnion(withNotFound),
    );
  });
});

describe('the event stream document', () => {
  const connection = eventStreamsDocument.components.pathItems.eventStreamConnection;

  it('types the stream items as the `sseEvent` this package models', () => {
    const content = connection.get.responses['200'].content;

    expect(Object.keys(content)).toEqual(['text/event-stream']);
    expect(content['text/event-stream'].itemSchema.$ref).toBe(
      'openapi.yaml#/components/schemas/sseEvent',
    );
    expect(schemaForComponent('sseEvent')).toBeDefined();
  });
});
