import { Callout } from "~/components/primitives/Callout";

/**
 * Error state for a runs list that failed to load. Shown as the `errorElement` of the deferred
 * runs-list data. The most common recoverable cause is a query that was too expensive over a broad
 * time range (see `RunsListQueryError`), so the copy guides narrowing the range; a refresh covers
 * transient failures. The precise reason is not shown because Remix scrubs thrown error messages in
 * production.
 */
export function RunsListErrorState() {
  return (
    <div className="flex items-center justify-center px-3 py-12">
      <Callout variant="error" className="max-w-fit">
        We couldn't load these runs. If you're filtering over a broad time range, try narrowing it,
        then refresh to try again.
      </Callout>
    </div>
  );
}

/**
 * Renders nothing. Used as the `errorElement` for secondary awaits of the same runs-list promise
 * (e.g. the pagination controls), so a rejection is handled locally there and does not bubble to
 * the route error boundary. The primary awaits render {@link RunsListErrorState}.
 */
export function RunsListErrorStateNoop() {
  return null;
}
