/**
 * The pure text of the watch UI: a chip's label and its tooltip.
 *
 * A chip has one line of room in a 380px panel, so the label names the thing being
 * watched and the icon carries the state. The label comes from the watch `identity`,
 * the same dedup key the store uses, so a chip cannot disagree with the store about
 * what it watches.
 */
import type { WatchStatus } from "@internal/dashboard-agent-contracts";

// The immediate-check wording lives in the presenter with the rest of the
// user-facing copy. Re-exported here for chip callers.
export { immediateWatchMessage } from "~/presenters/v3/dashboardAgent";

import {
  formatWatchCadence,
  shortFingerprint,
  watchIdentityValue,
} from "~/presenters/v3/dashboardAgent";

const WATCH_STATUS_LABEL: Record<WatchStatus, string> = {
  active: "watching",
  fired: "fired",
  expired: "expired",
  cancelled: "cancelled",
};

/** Fingerprints are hashes — a chip shows just enough of one to tell them apart. */
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
    case "run_failed":
    case "backlog_drain":
    case "queue_stalled":
      return value || fallbackLabel(watch);
    // Identity is `{kind}:{queue}:{number}` here. The chip names the queue; the
    // number goes in the tooltip's note, where there is room for it.
    case "queue_depth_above":
    case "queue_depth_below":
    case "queue_oldest_age":
      return watchIdentityValue(watch.kind, watch.identity) || fallbackLabel(watch);
    case "error_recurrence":
      return value ? shortFingerprint(value) : fallbackLabel(watch);
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
  const cadence = formatWatchCadence(watch.checkEveryMinutes);
  return [note, cadence, WATCH_STATUS_LABEL[watch.status]].filter(Boolean).join(" · ");
}
