/**
 * #13 The dashboard-wide signal that a watch woke a chat while the panel was
 * closed. The launcher's dot is easy to miss, so a wake also raises a toast.
 *
 * Persistent by design: a wake is the answer to a question the user asked
 * minutes or hours ago, so it waits until it's dismissed rather than expiring on
 * a 5s timer. Dismissing does NOT mark the chat read — reading happens in the
 * panel, so the dot survives a swatted toast.
 *
 * Styled to match `~/components/primitives/Toast` (same `toast.custom` render
 * pattern, same shell) instead of importing its `ToastUI`, which is fixed to the
 * success/error icons.
 */
import { BoltIcon, EyeIcon, XMarkIcon } from "@heroicons/react/20/solid";
import { toast } from "sonner";
import { Button } from "~/components/primitives/Buttons";
import { Header2 } from "~/components/primitives/Headers";
import { Paragraph } from "~/components/primitives/Paragraph";
import { cn } from "~/utils/cn";

/** Matches sonner's default toast width, same as the app's other toasts. */
const TOAST_WIDTH = 356;

/** More new wakes than this at once collapse into one summary toast. */
export const WAKE_TOAST_MAX_INDIVIDUAL = 3;

export type WatchWake = {
  watchId: string;
  chatId: string;
  outcome: "fired" | "expired";
  note: string;
};

function WakeToastUI({
  t,
  title,
  message,
  outcome,
  onOpenChat,
}: {
  t: string;
  title: string;
  message: string;
  outcome?: "fired" | "expired";
  onOpenChat: () => void;
}) {
  // A fire is the watch's news; an expiry is the watch giving up.
  const Icon = outcome === "expired" ? EyeIcon : BoltIcon;

  return (
    <div
      className="self-end rounded-md border border-grid-bright bg-background-dimmed"
      style={{ width: TOAST_WIDTH }}
    >
      <div className="flex w-full items-start gap-2 rounded-lg p-3">
        <Icon
          className={cn(
            "mt-1 size-4 min-w-4",
            outcome === "expired" ? "text-text-dimmed" : "text-indigo-500"
          )}
        />
        <div className="flex flex-col">
          <Header2 className="pt-0">{title}</Header2>
          <Paragraph variant="small/dimmed" className="pb-1 pt-0.5">
            {message}
          </Paragraph>
          <Button
            variant="secondary/small"
            className="my-2"
            onClick={() => {
              onOpenChat();
              toast.dismiss(t);
            }}
          >
            Open chat
          </Button>
        </div>
        <button
          className="-mr-1 -mt-1 ms-auto rounded p-2 text-text-dimmed transition hover:text-text-bright"
          aria-label="Dismiss"
          onClick={() => toast.dismiss(t)}
        >
          <XMarkIcon className="size-4" />
        </button>
      </div>
    </div>
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

/** One persistent toast for a single wake. */
export function showWatchWakeToast(wake: WatchWake, onOpenChat: () => void) {
  show(
    (t) => (
      <WakeToastUI
        t={t}
        title="Watch update"
        message={wake.note}
        outcome={wake.outcome}
        onOpenChat={onOpenChat}
      />
    ),
    `watch-wake-${wake.watchId}`
  );
}

/** One persistent toast standing in for a batch too large to narrate one by one. */
export function showWatchWakesSummaryToast(count: number, onOpenChat: () => void) {
  show(
    (t) => (
      <WakeToastUI
        t={t}
        title="Watch updates"
        message={`${count} watch updates — open the chat panel.`}
        onOpenChat={onOpenChat}
      />
    ),
    `watch-wakes-summary-${count}-${Date.now()}`
  );
}
