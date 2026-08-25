import { describe, expect, it } from 'vitest';

import { parseFlagDefinitions, parseRuleset } from '../../src/index.js';

const validFlag = {
  key: 'new-checkout',
  enabled: true,
  variants: { on: true, off: false },
  defaultVariant: 'off',
  offVariant: 'off',
};

const validSegment = {
  key: 'beta-testers',
  included: ['user-1'],
  rules: [
    {
      id: 'internal',
      conditions: [{ attribute: 'email', operator: 'endsWith', value: '@example.com' }],
    },
  ],
};

describe('parseFlagDefinitions', () => {
  it('reads an array and a key-to-definition object', () => {
    expect(parseFlagDefinitions([validFlag]).flags).toHaveLength(1);
    expect(parseFlagDefinitions({ 'new-checkout': validFlag }).flags[0]?.key).toBe('new-checkout');
  });

  it('keeps the good flags and isolates the bad ones', () => {
    const { flags, issues } = parseFlagDefinitions([
      validFlag,
      { key: 'broken', enabled: 'nope' },
      { ...validFlag, key: 'other' },
    ]);

    expect(flags.map((flag) => flag.key)).toEqual(['new-checkout', 'other']);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.at).toBe('broken');
  });

  it('reports a root-level shape error', () => {
    const { flags, issues } = parseFlagDefinitions('not flags');
    expect(flags).toEqual([]);
    expect(issues[0]?.at).toBe('flags');
  });
});

describe('parseRuleset', () => {
  it('reads a bare array as flags only', () => {
    const result = parseRuleset([validFlag]);
    expect(result.flags).toHaveLength(1);
    expect(result.segments).toEqual([]);
    expect(result.issues).toEqual([]);
  });

  it('reads a legacy key-to-definition object as flags only', () => {
    const result = parseRuleset({ 'new-checkout': validFlag });
    expect(result.flags[0]?.key).toBe('new-checkout');
    expect(result.segments).toEqual([]);
  });

  it('reads the document form with flags and segments', () => {
    const result = parseRuleset({ flags: [validFlag], segments: [validSegment] });
    expect(result.flags).toHaveLength(1);
    expect(result.segments).toHaveLength(1);
    expect(result.issues).toEqual([]);
  });

  it('accepts a document with only one side present', () => {
    expect(parseRuleset({ segments: [validSegment] }).segments).toHaveLength(1);
    expect(parseRuleset({ flags: [validFlag] }).flags).toHaveLength(1);
  });

  it('collects issues from both sides without dropping the good definitions', () => {
    const result = parseRuleset({
      flags: [validFlag, { key: 'broken' }],
      segments: [validSegment, { key: 'empty' }],
    });

    expect(result.flags).toHaveLength(1);
    expect(result.segments).toHaveLength(1);
    expect(result.issues.map((issue) => issue.at)).toEqual(['broken', 'empty']);
  });

  it('reads an explicit null side as absent rather than malformed', () => {
    // A control plane that serialises an empty segment set as null should not
    // draw a parse issue on every refresh.
    const result = parseRuleset({ flags: [validFlag], segments: null });

    expect(result.flags).toHaveLength(1);
    expect(result.segments).toEqual([]);
    expect(result.issues).toEqual([]);
    expect(parseRuleset({ flags: null, segments: [validSegment] }).issues).toEqual([]);
  });
});

describe('parseRuleset duplicate keys', () => {
  it('keeps the first definition of a repeated flag key and reports the rest', () => {
    // A snapshot is indexed by key, so the second would silently delete the
    // first. Which one ends up live must not come down to array order.
    const result = parseRuleset([validFlag, { ...validFlag, enabled: false }]);

    expect(result.flags).toHaveLength(1);
    expect(result.flags[0]?.enabled).toBe(true);
    expect(result.issues).toEqual([
      { at: 'new-checkout', message: 'flag new-checkout is defined more than once' },
    ]);
  });

  it('reports a repeated segment key the same way', () => {
    const result = parseRuleset({ flags: [], segments: [validSegment, validSegment] });

    expect(result.segments).toHaveLength(1);
    expect(result.issues).toEqual([
      { at: 'beta-testers', message: 'segment beta-testers is defined more than once' },
    ]);
  });
});

describe('parseRuleset cross-references', () => {
  const gated = {
    ...validFlag,
    key: 'gated',
    prerequisites: [{ flag: 'new-checkout', variants: ['on'] }],
  };

  it('accepts references that resolve', () => {
    expect(parseRuleset({ flags: [validFlag, gated], segments: [] }).issues).toEqual([]);
  });

  it('reports a prerequisite that is not in the ruleset', () => {
    const result = parseRuleset([
      { ...gated, prerequisites: [{ flag: 'gone', variants: ['on'] }] },
    ]);

    // The flag is kept: it already fails closed at evaluation, and dropping it
    // would answer FLAG_NOT_FOUND and send every SDK to its own default.
    expect(result.flags).toHaveLength(1);
    expect(result.issues).toEqual([
      { at: 'gated', message: 'flag gated: prerequisite gone is not in this ruleset' },
    ]);
  });

  it('reports a prerequisite variant the dependency does not have', () => {
    const typo = { ...gated, prerequisites: [{ flag: 'new-checkout', variants: ['onn'] }] };
    const result = parseRuleset([validFlag, typo]);

    expect(result.issues).toEqual([
      {
        at: 'gated',
        message: 'flag gated: prerequisite new-checkout lists unknown variant onn',
      },
    ]);
  });

  it('reports a rule referencing a segment key the ruleset does not define', () => {
    const flag = {
      ...validFlag,
      rules: [
        {
          id: 'beta',
          conditions: [{ operator: 'inSegment', segments: ['beta-tester'] }],
          variant: 'on',
        },
      ],
    };
    const result = parseRuleset({ flags: [flag], segments: [validSegment] });

    expect(result.flags).toHaveLength(1);
    expect(result.issues).toEqual([
      {
        at: 'new-checkout',
        message: 'flag new-checkout: rule beta references unknown segment beta-tester',
      },
    ]);

    // Spelled right, it resolves.
    const fixed = {
      ...flag,
      rules: [
        { ...flag.rules[0], conditions: [{ operator: 'inSegment', segments: ['beta-testers'] }] },
      ],
    };
    expect(parseRuleset({ flags: [fixed], segments: [validSegment] }).issues).toEqual([]);
  });

  it('stays quiet about segments when the payload declares no segment side', () => {
    // A bare flag array may well have its segments loaded from elsewhere.
    const flag = {
      ...validFlag,
      rules: [
        {
          id: 'beta',
          conditions: [{ operator: 'inSegment', segments: ['loaded-elsewhere'] }],
          variant: 'on',
        },
      ],
    };

    expect(parseRuleset([flag]).issues).toEqual([]);
    expect(parseRuleset({ flags: [flag] }).issues).toEqual([]);
  });
});

describe('unrecognised keys in a ruleset document', () => {
  const gatedOnSegment = {
    ...validFlag,
    rules: [
      {
        id: 'beta',
        conditions: [{ operator: 'inSegment', segments: ['beta-testers'] }],
        variant: 'on',
      },
    ],
  };

  it('reports a misspelled segments key instead of losing every segment in silence', () => {
    // The typo used to cost the segments *and* the dangling-segment check:
    // the document looked like it declared no segment side, so every inSegment
    // rule matched nobody with nothing to explain why.
    const result = parseRuleset({ flags: [gatedOnSegment], segmnets: [validSegment] });

    expect(result.segments).toEqual([]);
    expect(result.issues).toEqual([
      { at: 'segmnets', message: expect.stringMatching(/unrecognised top-level key "segmnets"/u) },
    ]);
  });

  it('reports a flag that the document form shadows', () => {
    // The legacy key-to-definition form cannot use `flags` or `segments` as a
    // flag key. That was already true; now it is said out loud.
    const result = parseRuleset({ checkout: validFlag, segments: [validSegment] });

    expect(result.flags).toEqual([]);
    expect(result.issues).toEqual([
      { at: 'checkout', message: expect.stringMatching(/unrecognised top-level key "checkout"/u) },
    ]);
  });

  it('stays quiet about scalar document metadata', () => {
    // A control plane is free to ship a revision alongside the definitions.
    const result = parseRuleset({
      flags: [validFlag],
      segments: [validSegment],
      version: 'rev-42',
      updatedAt: 1_700_000_000,
    });

    expect(result.flags).toHaveLength(1);
    expect(result.issues).toEqual([]);
  });

  it('stays quiet about a nested envelope that could never have held definitions', () => {
    // A control plane shipping metadata, links, or pagination alongside its
    // definitions would otherwise draw an issue on every refresh — every
    // thirty seconds on the default poll — with nothing the operator could do
    // about it short of flattening the document.
    const result = parseRuleset({
      flags: [validFlag],
      segments: [validSegment],
      metadata: { env: 'prod', owner: 'growth' },
      links: { next: '/rulesets?page=2' },
      pagination: { total: 2, cursor: 'abc' },
    });

    expect(result.flags).toHaveLength(1);
    expect(result.issues).toEqual([]);
  });

  it('says nothing about the legacy object form when no document key is present', () => {
    expect(parseRuleset({ 'new-checkout': validFlag }).issues).toEqual([]);
  });

  it('stays quiet about an envelope whose own entries carry a key', () => {
    // Carrying a `key` is what every definition has in common, and it is not
    // enough on its own: a named envelope and a link table were reported as
    // misplaced definitions on every refresh, which is exactly the noise the
    // check above promises to leave alone.
    const result = parseRuleset({
      flags: [validFlag],
      segments: [validSegment],
      meta: { key: 'prod-ruleset', revision: 42 },
      links: { self: { key: 'a' }, next: { key: 'b' } },
    });

    expect(result.flags).toHaveLength(1);
    expect(result.issues).toEqual([]);
  });

  it('still reports a misspelled key holding real definitions', () => {
    // The typo diagnostic has to survive the narrowing: a definition declares
    // something to be a definition of, and these do.
    expect(parseRuleset({ flags: [], flgas: [validFlag] }).issues).toEqual([
      { at: 'flgas', message: expect.stringMatching(/unrecognised top-level key "flgas"/u) },
    ]);
    expect(parseRuleset({ flags: [], segmnets: { beta: validSegment } }).issues).toEqual([
      { at: 'segmnets', message: expect.stringMatching(/unrecognised top-level key "segmnets"/u) },
    ]);
  });
});

describe('prerequisite cycles', () => {
  const linked = (key: string, dependsOn: string): unknown => ({
    ...validFlag,
    key,
    prerequisites: [{ flag: dependsOn, variants: ['on'] }],
  });

  it('reports a two-flag cycle at parse time', () => {
    // Evaluation already catches this and answers INVALID_DEFINITION, but that
    // carries no value at all and only surfaces once a request arrives.
    const result = parseRuleset([linked('a', 'b'), linked('b', 'a')]);

    expect(result.flags).toHaveLength(2);
    expect(result.issues).toEqual([{ at: 'b', message: 'flag b: prerequisite a closes a cycle' }]);
  });

  it('reports a longer cycle once, not once per path into it', () => {
    const result = parseRuleset([linked('a', 'b'), linked('b', 'c'), linked('c', 'a')]);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]?.message).toMatch(/closes a cycle/u);
  });

  it('leaves an acyclic diamond alone', () => {
    // a → b, a → c, b → d, c → d: d is reached twice and is not a cycle.
    const diamond = [
      {
        ...validFlag,
        key: 'a',
        prerequisites: [
          { flag: 'b', variants: ['on'] },
          { flag: 'c', variants: ['on'] },
        ],
      },
      linked('b', 'd'),
      linked('c', 'd'),
      { ...validFlag, key: 'd' },
    ];

    expect(parseRuleset(diamond).issues).toEqual([]);
  });

  it('does not mistake a dangling prerequisite for a cycle', () => {
    const result = parseRuleset([linked('a', 'gone')]);

    expect(result.issues).toEqual([
      { at: 'a', message: 'flag a: prerequisite gone is not in this ruleset' },
    ]);
  });
});
