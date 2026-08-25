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
