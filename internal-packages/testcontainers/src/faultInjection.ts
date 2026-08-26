// Test-only fault-injection harness, shared by the snapshot decorator (crash-gap) and the waitpoint
// lane. Generic over the boundary union; the caller passes the error constructor, so this package
// takes no dependency on @internal/run-store (which would close a dependency cycle). The armed hook
// is SYNCHRONOUS: a crash at a write boundary must interrupt before the next write.

export type FaultInjector<TBoundary extends string> = {
  arm(boundary: TBoundary, opts?: { times?: number; runId?: string }): void;
  disarm(boundary?: TBoundary): void;
  hook: (boundary: TBoundary, context?: { runId?: string }) => void;
  fired(boundary: TBoundary): number;
};

type Armed = { remaining: number; runId?: string };

export function createFaultInjector<TBoundary extends string>(opts: {
  error: (boundary: TBoundary) => Error;
}): FaultInjector<TBoundary> {
  const armed = new Map<TBoundary, Armed>();
  const counts = new Map<TBoundary, number>();

  return {
    arm(boundary, o) {
      const times = o?.times ?? Infinity;
      if (times !== Infinity && (!Number.isInteger(times) || times < 0)) {
        throw new RangeError("times must be a non-negative integer or Infinity");
      }
      armed.set(boundary, { remaining: times, runId: o?.runId });
    },
    disarm(boundary) {
      if (boundary === undefined) armed.clear();
      else armed.delete(boundary);
    },
    hook: (boundary, context) => {
      const a = armed.get(boundary);
      if (!a || a.remaining <= 0) return;
      if (a.runId !== undefined && a.runId !== context?.runId) return;
      a.remaining -= 1;
      if (a.remaining <= 0) armed.delete(boundary);
      counts.set(boundary, (counts.get(boundary) ?? 0) + 1);
      throw opts.error(boundary);
    },
    fired(boundary) {
      return counts.get(boundary) ?? 0;
    },
  };
}
