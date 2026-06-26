import { AnimatedCallout } from "~/components/primitives/AnimatedCallout";

export function BillingLimitResolveProgress({
  show,
  cancellingQueuedRuns,
}: {
  show: boolean;
  cancellingQueuedRuns: boolean;
}) {
  if (!show) {
    return null;
  }

  return (
    <div className="space-y-3">
      <AnimatedCallout show variant="success">
        Billing limit resolved. Environments are being unpaused — this usually takes a few seconds.
      </AnimatedCallout>
      {cancellingQueuedRuns && (
        <AnimatedCallout show variant="info">
          Cancelling queued runs across billable environments…
        </AnimatedCallout>
      )}
    </div>
  );
}
