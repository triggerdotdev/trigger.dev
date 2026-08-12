/**
 * The banner above a wake narration: the label, the icon and the tone frame, and
 * nothing else. The narration under it states the headline, the user's note and the
 * next step, and each of those is said once per wake — so the banner marks the
 * message as a wake rather than restating it.
 *
 * This component holds no kind-specific wording: tone and semantic icon come from
 * contracts and `app/presenters/v3/dashboardAgent`. All it decides is which glyph a
 * semantic icon draws and which frame a tone paints.
 *
 * A wake is identified by its message id, `wake:watch:{watchId}:{fired|expired}`.
 * That suffix is the transport encoding, not the outcome; the outcome comes off the
 * watch row.
 */
import {
  CheckCircleIcon,
  ClockIcon,
  ExclamationCircleIcon,
  ExclamationTriangleIcon,
  InformationCircleIcon,
} from "@heroicons/react/20/solid";
import type {
  WatchObservedOutcome,
  WatchResolution,
  WatchSemanticIcon,
} from "@internal/dashboard-agent-contracts";
import { cn } from "~/utils/cn";
import { type AgentTone, TONE_ICON_COLOR } from "./agent-badges";
import { presentResolvedWatch, WATCH_PRESENTATION_FALLBACK } from "~/presenters/v3/dashboardAgent";

const WAKE_ID_PREFIX = "wake:watch:";

/**
 * The wire encoding in a wake's message id, not the resolution: `window_completed`
 * and `condition_impossible` are both addressed as `expired`, and the row is the
 * authority on which one it was.
 */
export type WakeOutcome = "fired" | "expired";

/** The watch fields a banner can use. A `WatchChip` satisfies it. */
export type WakeWatch = {
  id: string;
  kind: string;
  note: string;
  identity: string;
  /** How the watch ended. Absent on a row written before the resolution model. */
  resolution?: WatchResolution | null;
  /** What the resolving check observed — the other half of the headline. */
  observedOutcome?: WatchObservedOutcome | null;
  /**
   * Why the watch ended, from its last result. Only used to reconstruct a
   * resolution for rows that predate the `resolution` column.
   */
  endedReason?: string | null;
};

export type WakeRef = { watchId: string; outcome: WakeOutcome };

/**
 * The watch a message narrates the wake of, or null when the message isn't a wake.
 * A watch id never ends in an outcome word, so splitting on the last colon is
 * unambiguous.
 */
export function wakeRefFromMessageId(messageId: string): WakeRef | null {
  if (!messageId.startsWith(WAKE_ID_PREFIX)) return null;
  const rest = messageId.slice(WAKE_ID_PREFIX.length);
  const split = rest.lastIndexOf(":");
  if (split <= 0) return null;
  const outcome = rest.slice(split + 1);
  if (outcome !== "fired" && outcome !== "expired") return null;
  return { watchId: rest.slice(0, split), outcome };
}

/** The watch a wake belongs to, when the host passed its watches down. */
export function findWakeWatch(watches: WakeWatch[] | undefined, watchId: string) {
  return watches?.find((watch) => watch.id === watchId);
}

/**
 * The watch's resolution, falling back to what the transport can prove for a row
 * written before the `resolution` column existed: `fired` is unambiguous, `expired`
 * splits on the last check's reason.
 */
export function wakeResolution(
  outcome: WakeOutcome,
  watch: Pick<WakeWatch, "resolution" | "endedReason"> | undefined
): WatchResolution {
  if (watch?.resolution) return watch.resolution;
  if (outcome === "fired") return "condition_met";
  return watch?.endedReason === "terminal_unsatisfied"
    ? "condition_impossible"
    : "window_completed";
}

/** What this banner shows, without the markup. */
export function wakePresentation(outcome: WakeOutcome, watch: WakeWatch | undefined) {
  if (!watch) return WATCH_PRESENTATION_FALLBACK;
  return presentResolvedWatch({
    kind: watch.kind,
    identity: watch.identity,
    resolution: wakeResolution(outcome, watch),
    observed: watch.observedOutcome ?? null,
  });
}

/**
 * Semantic icon to glyph. Which icon a resolved result deserves is decided in
 * contracts, and the rule there is that the icon follows the observed outcome, not
 * the resolution: a failed run gets `error`, not the check its `condition_met`
 * would suggest.
 */
const SEMANTIC_ICON: Record<WatchSemanticIcon, (props: { className?: string }) => JSX.Element> = {
  success: CheckCircleIcon,
  attention: ExclamationTriangleIcon,
  error: ExclamationCircleIcon,
  waiting: ClockIcon,
  info: InformationCircleIcon,
};

const TONE_FRAME: Record<AgentTone, string> = {
  neutral: "border-l-border-bright bg-background-bright/40",
  success: "border-l-success bg-success/10",
  warning: "border-l-warning bg-warning/10",
  error: "border-l-error bg-error/10",
};

export function WakeBanner({
  outcome,
  watch,
}: {
  /** The wire encoding from the wake's message id. */
  outcome: WakeOutcome;
  /** The watch that woke, when the host has it. Absent: the neutral fallback. */
  watch?: WakeWatch;
}) {
  const presentation = wakePresentation(outcome, watch);
  const tone = presentation.tone as AgentTone;
  const Icon = SEMANTIC_ICON[presentation.semanticIcon];

  return (
    <div
      className={cn("flex items-center gap-2 rounded-r-md border-l-2 px-3 py-2", TONE_FRAME[tone])}
    >
      <Icon className={cn("size-4 shrink-0", TONE_ICON_COLOR[tone])} />
      <p className="text-xxs font-medium uppercase tracking-wider text-text-dimmed">
        {presentation.label}
      </p>
    </div>
  );
}
