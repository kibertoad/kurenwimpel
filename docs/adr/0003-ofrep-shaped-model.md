# 0003 — The domain model is OFREP-expressible by construction

Date: 2026-08-24 · Status: accepted

## Context

`@kurenwimpel/ofrep` transcribes the OpenFeature Remote Evaluation Protocol
(v0.3.0) as an executable contract, and serving it is a stated goal: every
community OFREP provider, in any language, should be able to read flags from
this project. The contract package's README enumerated three seams where the
old core model could not cross the wire: evaluation reasons the protocol has
no name for, values with no wire representation, and a nested context where
the protocol's is flat.

An adapter could paper over each seam at serving time. But every lossy
adapter is a place where the system's observable behaviour differs from its
model, discovered in production. The core is pre-1.0 and explicitly
malleable; the contract is external and fixed.

## Decision

Move the model to the protocol, at the three seams:

1. **Reasons.** The reason vocabulary spells every OFREP-expressible reason
   identically (`STATIC`, `TARGETING_MATCH`, `SPLIT`, `DISABLED`); the old
   `DEFAULT` became `STATIC` (OFREP 0.3.0 has no `DEFAULT`; the OpenFeature
   _SDK_ spec has both, and "the statically configured default variant" is
   what actually happened). The two reasons the protocol cannot name —
   `NOT_ALLOCATED`, `PREREQUISITE_FAILED` — carry real information for
   experiment analysis, so they exist in-process, and `model/ofrep.ts` pins
   their canonical wire mapping (`STATIC` and `DISABLED` respectively) plus
   the error-code mapping, so the future server handler starts from one
   mapping instead of inventing its own. The module uses string literals, not
   an import — the contract package stays dependency-free in both directions.

2. **Values.** `FlagValue` is `boolean | string | number | JsonObject`.
   OFREP's `evaluationSuccess` union has no arm for a top-level `null` or
   array, so the parser rejects such variant values with an error message that
   says why, and the types make them unrepresentable. An array-shaped value
   nests inside an object (`{ "hosts": [...] }`), which the wire can carry.

3. **Context.** `EvaluationContext` is flat — `targetingKey` alongside the
   attributes, exactly the OFREP/OpenFeature wire shape — and attribute values
   admit any JSON, as the protocol does. A context arriving over the wire is a
   context here; no mapping, no dropped attributes. Operators are typed
   instead: a condition that needs a string never matches an object, fail
   closed. Flat also reads better at call sites:
   `{ targetingKey: user.id, plan: user.plan }`.

`FlagDefinition.metadata` (scalar-valued, per the OFREP `metadata` schema)
rides along to every result and impression — the natural home for an
experiment id.

## Consequences

- The eventual OFREP handler is a projection, not a translation: pick the
  value arm, map two reasons, map error codes. All of it already written and
  tested in `model/ofrep.ts`.
- Existing definitions with top-level array/null variants (there are none in
  this repo) would be rejected at parse; the error message names the fix.
- `TYPE_MISMATCH` stays a client-side concern, as the protocol intends — an
  OFREP server sends the value in its natural type and never reports one.

## Alternatives rejected

- **Keep the richer model, adapt at the edge.** Every deviation becomes
  serving-time behaviour that the model cannot predict (which flags silently
  vanish from bulk responses? what does a `null` variant serve?). The README
  of the contract package called these out precisely so they would not be
  discovered "late and painfully"; this ADR is the acting-on-it.
- **Depend on `@kurenwimpel/ofrep` from the core** for the reason/code types.
  Inverts the layering — the contract is a specification and depends on
  nothing; the core should be usable without zod. Literals plus the contract's
  own tests give the same guarantee.
- **Widen OFREP handling to accept arrays/null** (wrap on the wire). The
  contract deliberately refuses to loosen `type: object` — matching the
  specification is the point of having it.
