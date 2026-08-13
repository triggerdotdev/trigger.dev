/**
 * Marks a deliberately un-awaited promise as handled without consuming it.
 *
 * For promises created eagerly and consumed later — handed to Remix `defer()`,
 * or composed into another promise after further awaits — a rejection that
 * lands before the consumer subscribes counts as an unhandled rejection, and
 * Node brings the whole process down on those. The no-op catch here is a
 * separate branch: awaiting the returned promise still rejects as normal
 * (e.g. into a `<TypedAwait errorElement>`), and a branch nobody ever awaits
 * simply logs nothing instead of crashing the server.
 */
export function backstopPromise<T>(promise: Promise<T>): Promise<T> {
  promise.catch(() => {});
  return promise;
}
