/**
 * #13 The dashboard-wide signal that a watch woke a chat while the panel was
 * closed. The launcher's dot is easy to miss, so a wake also raises a toast.
 *
 * Persistent by design: a wake is the answer to a question the user asked
 * minutes or hours ago, so it waits until it's dismissed rather than expiring on
 * a 5s timer. Dismissing does NOT mark the chat read — reading happens in the
 * panel, so the dot survives a swatted toast.
 *
 * The content is the standard `Callout` in its `agent` variant (the launcher's
 * chat icon, the agent's indigo accent), inside the sonner shell the app's other
 * toasts use — so a wake looks like everything else the dashboard says, not like
 * a one-off panel.
 */
import { XMarkIcon } from "@heroicons/react/20/solid";
import { toast } from "sonner";
import { Button } from "~/components/primitives/Buttons";
import { Callout } from "~/components/primitives/Callout";
import { Header2 } from "~/components/primitives/Headers";
import { Paragraph } from "~/components/primitives/Paragraph";

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
  onOpenChat,
}: {
  t: string;
  title: string;
  message: string;
  onOpenChat: () => void;
}) {
  return (
    // Opaque base under the callout: a callout is translucent by design, and a
    // toast has to read over whatever page is behind it.
    <div className="self-end rounded-md bg-background-dimmed" style={{ width: TOAST_WIDTH }}>
      <Callout
        variant="agent"
        cta={
          <button
            className="-mr-1 -mt-1 rounded p-1 text-text-dimmed transition hover:text-text-bright"
            aria-label="Dismiss"
            onClick={() => toast.dismiss(t)}
          >
            <XMarkIcon className="size-4" />
          </button>
        }
      >
        <div className="flex flex-col items-start gap-1">
          <Header2 className="pt-0">{title}</Header2>
          <Paragraph variant="small/dimmed">{message}</Paragraph>
          <Button
            variant="secondary/small"
            className="mt-1"
            onClick={() => {
              onOpenChat();
              toast.dismiss(t);
            }}
          >
            Open chat
          </Button>
        </div>
      </Callout>
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

/**
 * One persistent toast for a single wake. `onOpenChat` is given the chat the wake
 * happened in — the toast is about that conversation, so it must open that one
 * rather than whichever chat the panel had last.
 */
export function showWatchWakeToast(wake: WatchWake, onOpenChat: (chatId: string) => void) {
  show(
    (t) => (
      <WakeToastUI
        t={t}
        title="Watch update"
        message={wake.note}
        onOpenChat={() => onOpenChat(wake.chatId)}
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
