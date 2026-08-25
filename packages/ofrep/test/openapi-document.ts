/**
 * The vendored OFREP documents, and the normalisation that makes them
 * comparable to the schemas in `src/`.
 *
 * Both sides are reduced to the same shape descriptor, so one comparison covers
 * both directions of drift: an upstream change to the document, and a local
 * change to a schema. The descriptor keeps what a wire format is made of —
 * which properties exist, which are required, what type each holds, which
 * values an enum admits — and drops what only a reader cares about:
 * descriptions, examples, formats, patterns, bounds. `format: float` and
 * `minLength: 1` are refinements of a type, not a different type, so they are
 * where the contract is allowed to be stricter than the document without a test
 * failing.
 *
 * The two documents are read as data, never as a source of truth about the
 * schemas' *intent* — the deliberate deviations are declared in the tests that
 * use this module.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';

import { parse } from 'yaml';
import * as z from 'zod/mini';

/** A JSON Schema or OpenAPI node. Untyped on purpose: this is someone else's document. */
type Node = any;

const SPEC_DIR = path.join(import.meta.dirname, '..', 'spec');

/** Raw bytes, for the checksum comparison against `provenance.json`. */
export const readSpecFile = (file: string): Buffer => readFileSync(path.join(SPEC_DIR, file));

const parseDocument = (file: string): Node => parse(readSpecFile(file).toString('utf8'));

export const openapiDocument: Node = parseDocument('openapi.yaml');
export const eventStreamsDocument: Node = parseDocument('event-streams.yaml');
export const provenance: Node = JSON.parse(readSpecFile('provenance.json').toString('utf8'));

export const componentSchemas: Node = openapiDocument.components.schemas;

/** Resolves a local `$ref` against `openapi.yaml`; anything else is a mistake here. */
export const deref = (node: Node): Node => {
  const ref: unknown = node?.$ref;
  if (typeof ref !== 'string') return node;

  if (!ref.startsWith('#/')) {
    throw new Error(`Cannot resolve non-local $ref: ${ref}`);
  }

  return ref
    .slice(2)
    .split('/')
    .reduce<Node>((current, segment) => current[segment], openapiDocument);
};

/**
 * Sorts anything comparable as text — enum members are JSON values, and the two
 * sides only have to agree on an order, not on a meaningful one.
 */
const byText = (a: unknown, b: unknown): number => String(a).localeCompare(String(b));

/**
 * The canonical type of a node: a JSON Schema type name, `a|b` for a union of
 * them, or `unknown` where the document declares none.
 */
export const typeOf = (node: Node): string => {
  if (node === undefined || typeof node === 'boolean') return 'unknown';

  const schema = deref(node);
  if (schema.type !== undefined) {
    return Array.isArray(schema.type) ? [...schema.type].toSorted(byText).join('|') : schema.type;
  }

  const branches: Node[] | undefined = schema.oneOf ?? schema.anyOf;
  if (branches !== undefined) {
    return [...new Set(branches.map((branch) => typeOf(branch)))].toSorted(byText).join('|');
  }

  // `allOf` composes a type with annotation-only arms; the type is whichever arm has one.
  return (
    (schema.allOf ?? [])
      .map((arm: Node) => typeOf(arm))
      .find((type: string) => type !== 'unknown') ?? 'unknown'
  );
};

const enumOf = (node: Node): unknown[] | undefined => {
  const schema = deref(node);
  if (schema.enum !== undefined) return [...schema.enum].toSorted(byText);
  // `z.literal` renders as `const`; the document spells the same thing as a one-value enum.
  if (schema.const !== undefined) return [schema.const];

  return (schema.allOf ?? [])
    .map((arm: Node) => enumOf(arm))
    .find((values: unknown[] | undefined) => values !== undefined);
};

/** A property that nothing satisfies: `z.never()` renders as `{ not: {} }`. */
const isForbiddenProperty = (node: Node): boolean => {
  const schema = deref(node);
  return schema?.not !== undefined && Object.keys(deref(schema.not)).length === 0;
};

export type PropertyShape = { type: string; enum?: readonly unknown[] };

export type ObjectVariant = {
  required: readonly string[];
  properties: Record<string, PropertyShape>;
  additionalPropertyType: string;
};

export type SchemaShape =
  | { kind: 'scalar'; type: string; enum?: readonly unknown[] }
  | { kind: 'object'; variants: readonly ObjectVariant[] };

type RawVariant = {
  properties: Map<string, Node>;
  required: Set<string>;
  forbidden: Set<string>;
  additionalProperties: Node;
};

const emptyVariant = (): RawVariant => ({
  properties: new Map(),
  required: new Set(),
  forbidden: new Set(),
  additionalProperties: undefined,
});

const mergeVariants = (base: RawVariant, arm: RawVariant): RawVariant => ({
  properties: new Map([...base.properties, ...arm.properties]),
  required: new Set([...base.required, ...arm.required]),
  forbidden: new Set([...base.forbidden, ...arm.forbidden]),
  additionalProperties: arm.additionalProperties ?? base.additionalProperties,
});

/**
 * Folds one node's own constraints into `into`, following `$ref` and `allOf`,
 * and collects each `oneOf`/`anyOf` it defers to as a group of alternatives.
 *
 * `not: { required: [x] }` — how the document says "exactly one of these two" —
 * is read as forbidding `x`, which is the same statement `z.never()` makes on
 * the other side.
 */
const collect = (node: Node, into: RawVariant, groups: RawVariant[][]): void => {
  const schema = deref(node);

  for (const [name, property] of Object.entries<Node>(schema.properties ?? {})) {
    into.properties.set(name, property);
  }
  for (const name of schema.required ?? []) into.required.add(name);
  for (const name of deref(schema.not)?.required ?? []) into.forbidden.add(name);
  if (schema.additionalProperties !== undefined) {
    into.additionalProperties = schema.additionalProperties;
  }

  for (const arm of schema.allOf ?? []) collect(arm, into, groups);

  const branches: Node[] | undefined = schema.oneOf ?? schema.anyOf;
  if (branches !== undefined) {
    groups.push(branches.flatMap((branch) => rawVariantsOf(branch)));
  }
};

/** Expands a node into one variant per combination of its alternatives. */
const rawVariantsOf = (node: Node): RawVariant[] => {
  const base = emptyVariant();
  const groups: RawVariant[][] = [];
  collect(node, base, groups);

  return groups.reduce<RawVariant[]>(
    (variants, group) =>
      variants.flatMap((variant) => group.map((arm) => mergeVariants(variant, arm))),
    [base],
  );
};

const finalise = (raw: RawVariant): ObjectVariant => {
  const properties: Record<string, PropertyShape> = {};

  for (const [name, node] of raw.properties) {
    if (raw.forbidden.has(name) || isForbiddenProperty(node)) continue;
    const values = enumOf(node);
    properties[name] =
      values === undefined ? { type: typeOf(node) } : { type: typeOf(node), enum: values };
  }

  return {
    required: [...raw.required].filter((name) => !raw.forbidden.has(name)).toSorted(byText),
    properties,
    additionalPropertyType: typeOf(raw.additionalProperties),
  };
};

/** Total order over variants, so two descriptions of the same schema compare equal. */
const variantKey = (variant: ObjectVariant): string =>
  JSON.stringify([
    variant.required,
    Object.entries(variant.properties).toSorted(([a], [b]) => a.localeCompare(b)),
    variant.additionalPropertyType,
  ]);

const toObjectShape = (raw: RawVariant[]): SchemaShape => ({
  kind: 'object',
  variants: raw
    .map((variant) => finalise(variant))
    .toSorted((a, b) => variantKey(a).localeCompare(variantKey(b))),
});

const describeJsonSchema = (node: Node): SchemaShape => {
  const type = typeOf(node);
  if (!type.split('|').includes('object')) {
    const values = enumOf(node);
    return values === undefined ? { kind: 'scalar', type } : { kind: 'scalar', type, enum: values };
  }

  return toObjectShape(rawVariantsOf(node));
};

/** The shape a node of either document declares. */
export const describeSpecSchema = (node: Node): SchemaShape => describeJsonSchema(node);

/**
 * The shape a union of document nodes describes — for the one place the contract
 * admits an arm the document's own `oneOf` leaves out.
 */
export const describeSpecUnion = (nodes: readonly Node[]): SchemaShape =>
  toObjectShape(nodes.flatMap((node) => rawVariantsOf(node)));

/** The shape one of this package's schemas accepts, read through JSON Schema. */
export const describeContractSchema = (schema: unknown): SchemaShape =>
  describeJsonSchema(z.toJSONSchema(schema as z.core.$ZodType, { io: 'input' }));

export type SpecOperation = { id: string; path: string; method: string; operation: Node };

/** Every `path` × `method` the document defines, keyed `"post /ofrep/v1/..."`. */
export const specOperations = (): SpecOperation[] =>
  Object.entries<Node>(openapiDocument.paths).flatMap(([route, item]) =>
    Object.entries<Node>(item).map(([method, operation]) => ({
      id: `${method} ${route}`,
      path: route,
      method,
      operation,
    })),
  );

/** The property names an object schema of this package declares, in any variant. */
export const declaredPropertyNames = (schema: unknown): string[] => {
  const shape = describeContractSchema(schema);
  const names =
    shape.kind === 'object'
      ? shape.variants.flatMap((variant) => Object.keys(variant.properties))
      : [];

  return [...new Set(names)].toSorted(byText);
};
