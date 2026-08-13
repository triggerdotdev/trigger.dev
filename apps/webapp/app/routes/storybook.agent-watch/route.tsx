import {
  watchDraftFor,
  withFollowUp,
  withThreshold,
  withVariant,
} from "~/components/dashboard-agent/watch-card";
import { WatchCard } from "~/components/dashboard-agent/WatchCard";
import {
  errorWatchRecommendation,
  queueWatchRecommendation,
  runWatchRecommendation,
} from "~/components/dashboard-agent/watch-recommendations";
import { WatchResultBlock } from "~/components/dashboard-agent/WatchResultBlock";
import { watchWakeToastTitle, type WatchWake } from "~/components/dashboard-agent/WatchWakeToast";
import { cn } from "~/utils/cn";
import {
  watchConfirmationBlock,
  watchDegradedConfirmationBlock,
  watchSatisfiedBlock,
} from "../storybook.agent-ui/fixtures";
import { GalleryPage, noop, PANEL_FRAME } from "../storybook.agent-ui/gallery";

const queueWatchDraft = watchDraftFor(queueWatchRecommendation("email-sends"));

const runWatchDraft = withFollowUp(watchDraftFor(runWatchRecommendation("run_a1b2c3d4e5")), {
  investigateOnAttention: true,
});

const invalidThresholdDraft = withThreshold(
  withVariant(queueWatchDraft, "queue_depth_above"),
  Number.NaN
);

const queueBelowDraft = withThreshold(withVariant(queueWatchDraft, "queue_depth_below"), 100);
const queueStalledDraft = withVariant(queueWatchDraft, "queue_stalled");

const toastWakes: WatchWake[] = [
  {
    watchId: "watch_queue",
    chatId: "chat_demo",
    outcome: "fired",
    note: "tell me when the email-sends backlog clears",
    kind: "backlog_drain",
    identity: "backlog_drain:email-sends",
    resolution: "condition_met",
    observedOutcome: { kind: "backlog_drain", verified: true, depth: 0 },
  },
  {
    watchId: "watch_run_failed",
    chatId: "chat_demo",
    outcome: "fired",
    note: "ping me when the nightly backfill finishes",
    kind: "run_finished",
    identity: "run_finished:run_a1b2c3d4e5",
    resolution: "condition_met",
    observedOutcome: {
      kind: "run_finished",
      verified: true,
      finalStatus: "COMPLETED_WITH_ERRORS",
      durationMs: 812_000,
    },
  },
];

function WakeToastHeadlines({ wakes }: { wakes: WatchWake[] }) {
  return (
    <div className={cn(PANEL_FRAME, "space-y-3 p-3")}>
      {wakes.map((wake) => (
        <div key={wake.watchId} className="space-y-0.5">
          <p className="text-[10px] uppercase tracking-wide text-text-faint">{wake.kind}</p>
          <p className="text-sm text-text-bright">{watchWakeToastTitle(wake)}</p>
          <p className="text-xs text-text-dimmed">{wake.note}</p>
        </div>
      ))}
    </div>
  );
}

const STATES: Record<string, React.ReactNode> = {
  "watch-card-compact": (
    <WatchCard draft={queueWatchDraft} onChange={noop} onSubmit={noop} onCancel={noop} />
  ),
  "watch-card-expanded": (
    <WatchCard
      draft={runWatchDraft}
      onChange={noop}
      onSubmit={noop}
      onCancel={noop}
      defaultExpanded
    />
  ),
  "watch-card-validation-error": (
    <WatchCard
      draft={invalidThresholdDraft}
      onChange={noop}
      onSubmit={noop}
      onCancel={noop}
      defaultExpanded
    />
  ),
  "watch-card-pending": (
    <WatchCard
      draft={watchDraftFor(errorWatchRecommendation("a1b2c3d4e5f6"))}
      onChange={noop}
      onSubmit={noop}
      onCancel={noop}
      pending
    />
  ),
  "watch-card-queue-below": (
    <WatchCard draft={queueBelowDraft} onChange={noop} onSubmit={noop} defaultExpanded />
  ),
  "watch-card-queue-stalled": (
    <WatchCard draft={queueStalledDraft} onChange={noop} onSubmit={noop} defaultExpanded />
  ),
  "watch-card-confirmation": <WatchResultBlock block={watchConfirmationBlock} />,
  "watch-card-confirmation-degraded": <WatchResultBlock block={watchDegradedConfirmationBlock} />,
  "watch-card-one-shot-satisfied": <WatchResultBlock block={watchSatisfiedBlock} />,
  "watch-card-toast-headline": <WakeToastHeadlines wakes={toastWakes} />,
};

export default function Story() {
  return (
    <GalleryPage
      page="watch"
      states={STATES}
      componentNames={["WatchCard.tsx", "WatchResultBlock.tsx", "WatchWakeToast.tsx"]}
    />
  );
}
