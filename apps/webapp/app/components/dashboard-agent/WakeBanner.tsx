/**
 * The banner above a wake narration.
 *
 * A wake arrives unprompted: nobody typed anything, the watch resolved and the
 * chat spoke. Rendered as plain assistant prose it would read like an answer to a
 * question the user never asked — so the narration gets a banner that states the
 * FACT before the text does, with the outcome carried by a coloured accent and
 * icon (the same rule the run status cells and the watch chips follow: the text
 * keeps its colour, the state is the icon's job).
 *
 * **This component contains no kind-specific wording.** Category, tone, semantic
 * icon and headline key come from the exhaustive resolved-result mapping in
 * contracts; the final English comes from `watch-presentation.ts`. All this file
 * decides is which glyph a semantic icon draws and which frame a tone paints.
 *
 * A wake is identified by its message id — `wake:watch:{watchId}:{fired|expired}`.
 * That two-value suffix is the stable TRANSPORT encoding (§7.5): it is not the
 * outcome, it is how the wake is addressed. The outcome comes off the watch row.
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
import { presentResolvedWatch, WATCH_PRESENTATION_FALLBACK } from "./watch-presentation";

const WAKE_ID_PREFIX = "wake:watch:";

/**
 * The wire encoding in a wake's message id. NOT the resolution — a
 * `window_completed` and a `condition_impossible` are both addressed as
 * `expired`, and the row is the authority on which one it was.
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
   * Why the watch ended, from its last result — `terminal_unsatisfied` when the
   * condition became impossible. Only used to reconstruct a resolution for rows
   * that predate the `resolution` column.
   */
  endedReason?: string | null;
};

export type WakeRef = { watchId: string; outcome: WakeOutcome };

/**
 * The watch a message narrates the wake of, or null when the message isn't a
 * wake. The id is `wake:watch:{watchId}:{outcome}`; a watch id never ends in an
 * outcome word, so splitting on the last colon is unambiguous.
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
 * written before the `resolution` column existed. `fired` is unambiguous;
 * `expired` splits on the last check's reason, exactly as the old banner did.
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

/**
 * What this banner shows. Exported for the tests and for any surface that wants
 * the same answer without the markup.
 */
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
 * Semantic icon → glyph. The mapping lives here because the icon SET is this
 * app's; which icon a resolved result deserves was decided in contracts, and the
 * rule it encodes is that the icon follows the outcome, never the resolution — a
 * failed run gets `error`, not the success check its `condition_met` would
 * otherwise suggest.
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

/** What the watch was for: the user's own words, else whatever names it. */
function subline(watch: WakeWatch | undefined): string | null {
  const note = watch?.note.trim();
  if (note) return note;
  if (watch?.identity) return watch.identity;
  if (watch?.kind) return watch.kind;
  return null;
}

export function WakeBanner({
  outcome,
  watch,
}: {
  /** The wire encoding from the wake's message id (§7.5). */
  outcome: WakeOutcome;
  /** The watch that woke, when the host has it. Absent: the neutral fallback. */
  watch?: WakeWatch;
}) {
  const presentation = wakePresentation(outcome, watch);
  const tone = presentation.tone as AgentTone;
  const Icon = SEMANTIC_ICON[presentation.semanticIcon];
  const note = subline(watch);

  return (
    <div
      className={cn("flex items-start gap-2 rounded-r-md border-l-2 px-3 py-2", TONE_FRAME[tone])}
    >
      <Icon className={cn("mt-0.5 size-4 shrink-0", TONE_ICON_COLOR[tone])} />
      <div className="min-w-0">
        <p className="text-xxs font-medium uppercase tracking-wider text-text-dimmed">
          {presentation.label}
        </p>
        <p className="text-sm font-medium text-text-bright">{presentation.headline}</p>
        {note ? <p className="truncate text-xs text-text-dimmed">{note}</p> : null}
      </div>
    </div>
  );
}
