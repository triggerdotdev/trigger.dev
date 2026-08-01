/**
 * The pure text of the watch UI: what a chip is labelled, what its tooltip says,
 * and how an immediate outcome is worded.
 *
 * A chip has one line of room in a 380px panel, so the label names the *thing*
 * being watched (the run, the queue, the error) and the icon carries the state.
 * The label comes from the watch `identity` — the same dedup key the store uses —
 * so two chips can never disagree with the store about what they watch.
 */
import type { WatchStatus } from "@internal/dashboard-agent-contracts";

export const WATCH_STATUS_LABEL: Record<WatchStatus, string> = {
  active: "watching",
  fired: "fired",
  expired: "expired",
  cancelled: "cancelled",
};

/** Fingerprints are hashes — a chip shows just enough of one to tell them apart. */
const FINGERPRINT_CHARS = 8;

/**
 * The chip label for a watch. `identity` is `{kind}:{value}`, so the value is the
 * thing being watched; a health watch has no per-instance value, so its kind is
 * the label. Falls back to the note (then the kind) if the identity is unreadable.
 */
export function watchChipLabel(watch: { kind: string; identity: string; note: string }): string {
  const value = watch.identity.startsWith(`${watch.kind}:`)
    ? watch.identity.slice(watch.kind.length + 1)
    : "";

  switch (watch.kind) {
    case "run_start":
    case "run_finished":
    case "backlog_drain":
      return value || fallbackLabel(watch);
    case "error_recurrence":
      return value ? value.slice(0, FINGERPRINT_CHARS) : fallbackLabel(watch);
    case "health_recovery":
      return "health";
    default:
      return value || fallbackLabel(watch);
  }
}

/** Last resort: the first few words of the note, else the kind as written. */
function fallbackLabel(watch: { kind: string; note: string }): string {
  const words = watch.note.trim().split(/\s+/).filter(Boolean).slice(0, 3).join(" ");
  return words || watch.kind;
}

/** Everything that didn't fit on the chip: why it exists, and its cadence. */
export function watchChipTooltip(watch: {
  note: string;
  checkEveryMinutes: number;
  status: WatchStatus;
}): string {
  const note = watch.note.trim();
  const cadence = `every ${watch.checkEveryMinutes} min`;
  return [note, cadence, WATCH_STATUS_LABEL[watch.status]].filter(Boolean).join(" · ");
}

/**
 * A watch whose condition resolved the moment it was created never becomes a
 * chip — there is nothing left to watch — so the answer is said once, in a toast.
 *
 * `pending` and `unavailable` are not immediate outcomes (the watch stays active),
 * but they're handled so a future result can never fall through to nothing.
 */
export function immediateWatchMessage(result: string): string {
  switch (result) {
    case "satisfied":
      return "That already happened, so there's nothing left to watch.";
    case "terminal_unsatisfied":
      return "That can't happen any more, so there's nothing to watch.";
    case "unavailable":
      return "We couldn't check that just now. Watching anyway.";
    default:
      return "Watching.";
  }
}
