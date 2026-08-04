import { VIEW_BLOCK_VERSION } from "@internal/dashboard-agent-contracts";
import {
  watchDraftFor,
  withFollowUp,
  withThreshold,
  withVariant,
} from "~/components/dashboard-agent/watch-card";
import { WatchCard } from "~/components/dashboard-agent/WatchCard";
import {
  watchConfirmationBlockBody,
  watchOneShotBlockBody,
} from "~/components/dashboard-agent/watch-presentation";
import {
  errorWatchRecommendation,
  queueWatchRecommendation,
  runWatchRecommendation,
} from "~/components/dashboard-agent/watch-recommendations";
import { WatchResultBlock } from "~/components/dashboard-agent/WatchResultBlock";
import { watchWakeToastTitle, type WatchWake } from "~/components/dashboard-agent/WatchWakeToast";
import { cn } from "~/utils/cn";
import { GalleryPage, noop, PANEL_FRAME } from "../storybook.agent-ui/gallery";

/**
 * The watch card and what a submitted card leaves behind. The shell and the
 * manifest live in `../storybook.agent-ui`.
 *
 * The card is pure — draft in, callbacks out — so every state here is a fixed
 * draft plus a `noop` onChange: nothing on this page edits, and nothing is
 * submitted. The drafts come from the same recommendation helpers the real
 * Watch… action uses, so what the gallery shows is the condition each object
 * actually proposes.
 */

const queueWatchDraft = watchDraftFor(queueWatchRecommendation("email-sends"));

// A run watch with the "investigate if it turns out badly" opt-in already set,
// so the expanded state shows a checked box rather than two empty ones.
const runWatchDraft = withFollowUp(watchDraftFor(runWatchRecommendation("run_a1b2c3d4e5")), {
  investigateOnAttention: true,
});

// A threshold the schema refuses. No `error` prop: the point of the state is the
// card's OWN validation path (`watchDraftError`), which blocks the submit before
// anything reaches the server.
const invalidThresholdDraft = withThreshold(
  withVariant(queueWatchDraft, "queue_depth_above"),
  Number.NaN
);

// The queue pack (TRI-12890): a condition with its ONE contextual parameter, and
// the one that takes no parameter at all.
const queueBelowDraft = withThreshold(withVariant(queueWatchDraft, "queue_depth_below"), 100);
const queueStalledDraft = withVariant(queueWatchDraft, "queue_stalled");

/** The envelope a host-emitted `watch_result` block carries into the transcript. */
const WATCH_BLOCK_ENVELOPE = {
  id: "watch:watch_demo",
  revision: 0,
  version: VIEW_BLOCK_VERSION,
} as const;

const watchConfirmationBlock = {
  ...watchConfirmationBlockBody({
    spec: queueWatchRecommendation("email-sends"),
    watchId: "watch_demo",
    followUp: { investigateOnAttention: true, notifyExternally: true },
  }),
  ...WATCH_BLOCK_ENVELOPE,
};

const watchSatisfiedBlock = {
  ...watchOneShotBlockBody({
    spec: runWatchRecommendation("run_a1b2c3d4e5"),
    result: "satisfied",
  }),
  ...WATCH_BLOCK_ENVELOPE,
};

/**
 * The toast is a sonner portal, so it can't be rendered inline in a section —
 * what the gallery can show is the thing worth reviewing: the headline the
 * presenter produces, fact first, with the note the toast puts under it.
 */
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
  // Customize expands the same block in place — never a second surface.
  "watch-card-expanded": (
    <WatchCard
      draft={runWatchDraft}
      onChange={noop}
      onSubmit={noop}
      onCancel={noop}
      defaultExpanded
    />
  ),
  // Expanded so the field the message is about is on screen with it.
  "watch-card-validation-error": (
    <WatchCard
      draft={invalidThresholdDraft}
      onChange={noop}
      onSubmit={noop}
      onCancel={noop}
      defaultExpanded
    />
  ),
  // The submit is in flight: the card stays put, disabled, so nothing moves.
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
  // What a submitted card leaves in the transcript, built by the same presenter
  // the host freezes into the block — so the gallery shows the real wording.
  "watch-card-confirmation": <WatchResultBlock block={watchConfirmationBlock} />,
  "watch-card-one-shot-satisfied": <WatchResultBlock block={watchSatisfiedBlock} />,
  "watch-card-toast-headline": <WakeToastHeadlines wakes={toastWakes} />,
};

export default function Story() {
  return <GalleryPage page="watch" states={STATES} />;
}
