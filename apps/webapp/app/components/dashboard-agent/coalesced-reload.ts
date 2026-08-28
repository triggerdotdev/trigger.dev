/**
 * Coalesces reload requests without ever answering one with data older than it. Joining the
 * in-flight run would resolve a reload asked for after a turn finished with the list fetched
 * before it — the new chat missing, the title still the placeholder. So a request that arrives
 * mid-flight waits for a run started after it, and at most one such run is ever queued.
 */
export function createCoalescedReload(run: () => Promise<void>): () => Promise<void> {
  let inFlight: Promise<void> | null = null;
  let queued: Promise<void> | null = null;

  const start = (): Promise<void> => {
    const current = run().finally(() => {
      if (inFlight === current) inFlight = null;
    });
    inFlight = current;
    return current;
  };

  return () => {
    // Queued first: `inFlight` is cleared one microtask before the queued run starts.
    if (queued) return queued;
    if (!inFlight) return start();
    // Settles either way: a failed run must not strand the queued one.
    const next = inFlight
      .catch(() => {})
      .then(() => {
        queued = null;
        return start();
      });
    queued = next;
    return next;
  };
}
