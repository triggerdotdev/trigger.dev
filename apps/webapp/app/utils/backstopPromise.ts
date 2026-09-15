/**
 * Marks a deliberately un-awaited promise as handled without consuming it: a
 * rejection landing before the consumer subscribes would otherwise take the
 * process down. Awaiting the returned promise still rejects as normal.
 */
export function backstopPromise<T>(promise: Promise<T>): Promise<T> {
  promise.catch(() => {});
  return promise;
}
