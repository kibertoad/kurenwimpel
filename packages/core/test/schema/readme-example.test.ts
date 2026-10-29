import { describe, expect, it } from 'vitest';

import readme from '../../../../README.md?raw';
import { schemaErrors } from './validate.js';

// Imports no source module, so Stryker's related-test selection never loads it
// from a sandbox that has no repository README.
const exampleDefinition = (): unknown => {
  const section = readme.split('### Example definition')[1] ?? '';
  const block = /```json\n([\s\S]*?)\n```/u.exec(section)?.[1];
  if (block === undefined) throw new Error('README has no example definition block');
  return JSON.parse(block);
};

describe('the README example definition', () => {
  it('validates against the schema', () => {
    expect(schemaErrors([exampleDefinition()])).toEqual([]);
  });
});
