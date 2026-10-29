import { describe, expect, it } from 'vitest';

import readme from '../../../README.md?raw';
import { README_FLAG } from './readme-flag.js';

describe('the README example definition', () => {
  it('is the fixture every CLI test runs against', () => {
    const section = readme.split('### Example definition')[1] ?? '';
    const block = /```json\n([\s\S]*?)\n```/u.exec(section)?.[1];
    if (block === undefined) throw new Error('README has no example definition block');

    expect(JSON.parse(block)).toEqual(README_FLAG);
  });
});
