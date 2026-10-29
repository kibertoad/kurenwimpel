import { Ajv2020 } from 'ajv/dist/2020.js';

import schema from '../../schema/ruleset.schema.json' with { type: 'json' };

export { schema };

// The strict type checks want `type` repeated beside every `required` in an
// `if` or `anyOf` branch, where the enclosing schema already fixes the type.
const ajv = new Ajv2020({
  strict: true,
  strictTypes: false,
  strictRequired: false,
  allErrors: true,
});
const validator = ajv.compile(schema);

/** The schema's errors for a document, or an empty list when it validates. */
export function schemaErrors(document: unknown): string[] {
  if (validator(document)) return [];
  return (validator.errors ?? []).map((error) => `${error.instancePath} ${error.message ?? ''}`);
}
