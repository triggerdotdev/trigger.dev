/**
 * Batching for `trigger://` resolution. An investigation card cites ten to twenty targets, and
 * each request re-authorises and re-resolves the environment — so they go in one request.
 */

/** One environment lookup and one repo lookup serve a whole batch. */
export const MAX_URIS_PER_RESOLVE_REQUEST = 25;

/** A transient failure is worth retrying; a third one isn't. */
export const MAX_RESOLVE_ATTEMPTS = 3;

export const RESOLVE_RETRY_DELAY_MS = 1_000;

/**
 * A request in flight at unmount rejects afterwards. Its retry must not be scheduled: the
 * callback would fetch again for a component that is gone, and record the answer into state.
 * One timer serves every batch, so a pending one is not replaced either.
 */
export function shouldScheduleRetry({
  mounted,
  timerPending,
}: {
  mounted: boolean;
  timerPending: boolean;
}): boolean {
  return mounted && !timerPending;
}

/** Deduplicates, then splits into requests no bigger than the cap. */
export function planUriBatches(
  uris: readonly string[],
  cap: number = MAX_URIS_PER_RESOLVE_REQUEST
): string[][] {
  const unique = [...new Set(uris)];
  const batches: string[][] = [];
  for (let index = 0; index < unique.length; index += cap) {
    batches.push(unique.slice(index, index + cap));
  }
  return batches;
}
