/**
 * The dashboard-wide signal that a watch woke a chat while the panel was closed.
 *
 * Persistent by design: a wake answers a question asked minutes or hours ago, so it
 * waits until dismissed rather than expiring on a timer. Dismissing does not mark
 * the chat read (reading happens in the panel), so the launcher's dot survives a
 * swatted toast.
 */
import { toast } from "sonner";
import { Button } from "~/components/primitives/Buttons";
import { ToastUI } from "~/components/primitives/Toast";
import type { WatchObservedOutcome, WatchResolution } from "@internal/dashboard-agent-contracts";
import { wakeResolution } from "./WakeBanner";
import { presentResolvedWatch, WATCH_PRESENTATION_FALLBACK } from "~/presenters/v3/dashboardAgent";

/** Matches sonner's default toast width, same as the app's other toasts. */
const TOAST_WIDTH = 356;

/** More new wakes than this at once collapse into one summary toast. */
export const WAKE_TOAST_MAX_INDIVIDUAL = 3;

export type WatchWake = {
  watchId: string;
  chatId: string;
  /** The wire encoding off the row. Not the outcome; see `resolution`. */
  outcome: "fired" | "expired";
  note: string;
  /**
   * What actually happened, frozen on the row by the resolving check. The toast,
   * the banner and the email take their headline from the same presenter so they
   * cannot disagree. Absent on a row written before the resolution model, where the
   * presenter falls back rather than guessing.
   */
  kind?: string;
  identity?: string;
  resolution?: WatchResolution | null;
  observedOutcome?: WatchObservedOutcome | null;
  /** Landed after the chat's read marker. The dot counts these; the toast fires either way. */
  unread?: boolean;
};

/**
 * The toast's title: the fact, or the neutral fallback when this wake predates the
 * resolution model. The wording is `app/presenters/v3/dashboardAgent`'s; this only decides
 * which watch to ask it about.
 */
export function watchWakeToastTitle(wake: WatchWake): string {
  if (!wake.kind || !wake.identity) return WATCH_PRESENTATION_FALLBACK.headline;
  return presentResolvedWatch({
    kind: wake.kind,
    identity: wake.identity,
    resolution: wakeResolution(wake.outcome, { resolution: wake.resolution ?? null }),
    observed: wake.observedOutcome ?? null,
  }).headline;
}

function WakeToastUI({
  t,
  title,
  message,
  onOpenChat,
}: {
  t: string;
  title: string;
  message: string;
  onOpenChat: () => void;
}) {
  return (
    <ToastUI
      variant="agent"
      t={t}
      title={title}
      message={message}
      toastWidth={TOAST_WIDTH}
      actionNode={
        <Button
          variant="secondary/small"
          className="my-2 self-start"
          onClick={() => {
            onOpenChat();
            toast.dismiss(t);
          }}
        >
          Open chat
        </Button>
      }
    />
  );
}

function show(node: (t: string) => React.ReactElement, id: string) {
  toast.custom((t) => node(t as string), {
    // Manual dismissal only — see the file comment.
    duration: Infinity,
    // Keyed so a re-render or a duplicate poll can't stack the same wake twice.
    id,
  });
}

/**
 * One persistent toast for a single wake. `onOpenChat` is given the chat the wake
 * happened in, not whichever chat the panel had open last.
 */
export function showWatchWakeToast(wake: WatchWake, onOpenChat: (chatId: string) => void) {
  show(
    (t) => (
      <WakeToastUI
        t={t}
        title={watchWakeToastTitle(wake)}
        message={wake.note}
        onOpenChat={() => onOpenChat(wake.chatId)}
      />
    ),
    `watch-wake-${wake.watchId}`
  );
}

// One id for all summaries: a later poll rewrites the count in place instead of stacking a
// second never-expiring toast on top of the first.
const WAKES_SUMMARY_TOAST_ID = "watch-wakes-summary";

/** One persistent toast standing in for a batch too large to narrate one by one. */
export function showWatchWakesSummaryToast(count: number, onOpenChat: () => void) {
  show(
    (t) => (
      <WakeToastUI
        t={t}
        title="Watch updates"
        message={`${count} watch update${count === 1 ? "" : "s"} — open the chat panel.`}
        onOpenChat={onOpenChat}
      />
    ),
    WAKES_SUMMARY_TOAST_ID
  );
}

/**
 * Takes the summary off screen. Its count only means anything until the user opens the
 * panel; left up, a later poll would rewrite it to a smaller number.
 */
export function dismissWatchWakesSummaryToast() {
  toast.dismiss(WAKES_SUMMARY_TOAST_ID);
}
