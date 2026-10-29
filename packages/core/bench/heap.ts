/**
 * Retained-heap measurement for the snapshot benchmarks. Needs `--expose-gc`,
 * which `vitest.config.ts` passes to the bench workers; without it the numbers
 * would include garbage, so they are reported as unavailable instead.
 */

const MIB = 1024 * 1024;

/** The slice of Node's `process` this reads. Core's tsconfig carries no Node types. */
interface NodeProcess {
  memoryUsage(): { heapUsed: number };
}

function heapUsed(): number {
  return (Reflect.get(globalThis, 'process') as NodeProcess).memoryUsage().heapUsed;
}

function collector(): (() => void) | undefined {
  const gc: unknown = Reflect.get(globalThis, 'gc');
  if (typeof gc !== 'function') return undefined;
  return () => {
    Reflect.apply(gc, undefined, []);
  };
}

/** Bytes still reachable from what `build` returns, after a full collection. */
export function retainedBytes(build: () => unknown): number | undefined {
  const gc = collector();
  if (gc === undefined) return undefined;
  gc();
  const before = heapUsed();
  const kept = build();
  gc();
  const after = heapUsed();
  // Reading `kept` after the second collection is what keeps it alive through it.
  return kept === undefined ? undefined : after - before;
}

/** Prints one line per measurement, in the shape the CI comment shows. */
export function reportRetainedHeap(label: string, build: () => unknown): void {
  const bytes = retainedBytes(build);
  const shown =
    bytes === undefined ? 'unavailable (needs --expose-gc)' : `${(bytes / MIB).toFixed(2)} MiB`;
  console.log(`retained heap | ${label} | ${shown}`);
}
