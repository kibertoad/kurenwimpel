# 0001 — Evaluation is a pure function over an immutable snapshot

Date: 2026-08-24 · Status: accepted

## Context

A flag lookup sits on request hot paths. Whatever the storage story is —
Workers KV at the edge, a file in a container, an HTTP control plane — the
lookup itself must be synchronous, non-throwing, and identical across runtimes.

## Decision

The core is split along that line, and the source tree now says so:

- `model/` — plain-data types. Definitions arrive as JSON; nothing here may
  reference a platform API.
- `evaluation/` — pure functions. `evaluateFlag(flag, context, environment)`
  does no I/O, reads no clock, and never throws; malformed input becomes an
  `ERROR` result. The `environment` carries the two lookups a flag may need
  beyond itself: the other flags (prerequisites) and the segments.
- `parsing/` — validation for untrusted JSON. Everything the parser can catch
  is something the evaluator never handles on a request. One bad definition
  degrades to "this flag is ignored" plus an issue report, never to a crashed
  handler.
- `runtime/` — the stateful shell: `FlagSnapshot` (an immutable point-in-time
  view), `FlagProvider` (the platform seam), and `FeatureFlagClient` (context
  merging, typed getters, impressions).

Refreshes replace the snapshot atomically; evaluation only ever reads one.
Expensive preparation — today, compiling segment key lists into hash sets —
happens at snapshot construction, once per refresh, never per evaluation.

## Consequences

- Wrappers stay thin: a provider is one `load()` method, and the smallest
  complete example (`packages/node/src/file-provider.ts`) fits on a screen.
- Anything the evaluator needs must be in the snapshot. There is no "call out
  to a membership service" escape hatch, by design (see ADR 0004).
- The client's getters can promise "never throws, never awaits" because the
  layer below them promises "pure and total".

## Alternatives rejected

- **Async evaluation** (`await flags.get(...)` per lookup, as client-side SDKs
  often do). Pushes I/O and its failure modes into every call site; a request
  handler should not be able to stall on a flag.
- **Evaluating straight off the provider** with a cache inside. Hides
  staleness policy where it cannot be observed or tested; the snapshot makes
  it explicit and lets `refresh()` failures keep serving the previous view.
- **A god-object client** owning parsing, storage, and evaluation. That is
  what the directory split replaces: each layer is testable without the
  others, and the pure layers run identically under Node, workerd, or a test.
