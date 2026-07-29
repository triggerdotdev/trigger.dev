/**
 * The banner above a wake narration.
 *
 * A wake arrives unprompted: nobody typed anything, the watch fired and the chat
 * spoke. Rendered as plain assistant prose that reads like an answer to a
 * question the user never asked — so the narration gets a banner that says what
 * happened before the text does, with the outcome carried by a coloured accent
 * and icon (the same rule the run status cells and the watch chips follow: the
 * text keeps its colour, the state is the icon's job).
 *
 * A wake is identified by its message id — `wake:watch:{watchId}:{fired|expired}`,
 * written by the agent's `narrateWatchWake` — so no protocol change is needed to
 * spot one in the transcript.
 */
import { CheckCircleIcon, ClockIcon, ExclamationTriangleIcon } from "@heroicons/react/20/solid";
import { cn } from "~/utils/cn";
import { type AgentTone, TONE_ICON_COLOR } from "./agent-badges";

const WAKE_ID_PREFIX = "wake:watch:";

export type WakeOutcome = "fired" | "expired";

/** The watch fields a banner can use. A `WatchChip` satisfies it. */
export type WakeWatch = {
  id: string;
  kind: string;
  note: string;
  identity: string;
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

// Kinds whose condition being met is good news. `error_recurrence` is the
// inverse: it fires because something broke again.
const GOOD_NEWS_KINDS = new Set(["health_recovery", "backlog_drain", "run_start", "run_finished"]);

function toneFor(outcome: WakeOutcome, kind: string | undefined): AgentTone {
  if (outcome === "expired") return "neutral";
  if (kind === "error_recurrence") return "error";
  if (kind && GOOD_NEWS_KINDS.has(kind)) return "success";
  // Fired, but we don't know what for: say so without claiming an outcome.
  return "neutral";
}

function headlineFor(tone: AgentTone, outcome: WakeOutcome): string {
  if (outcome === "expired") return "Watch expired — no answer";
  switch (tone) {
    case "success":
      return "Watch update — all clear";
    case "error":
      return "Watch update — needs your attention";
    default:
      return "Watch update — condition met";
  }
}

const TONE_ICON: Record<AgentTone, (props: { className?: string }) => JSX.Element> = {
  neutral: ClockIcon,
  success: CheckCircleIcon,
  warning: ExclamationTriangleIcon,
  error: ExclamationTriangleIcon,
};

const TONE_FRAME: Record<AgentTone, string> = {
  neutral: "border-l-border-bright bg-background-bright/40",
  success: "border-l-success bg-success/10",
  warning: "border-l-warning bg-warning/10",
  error: "border-l-error bg-error/10",
};

/** What the watch was for: the user's own words, else whatever names it. */
function subline(watch: WakeWatch | undefined): string {
  const note = watch?.note.trim();
  if (note) return note;
  if (watch?.identity) return watch.identity;
  if (watch?.kind) return watch.kind;
  return "The watch woke this chat up on its own.";
}

export function WakeBanner({
  outcome,
  watch,
}: {
  outcome: WakeOutcome;
  /** The watch that woke, when the host has it. Absent: kind-agnostic wording. */
  watch?: WakeWatch;
}) {
  const tone = toneFor(outcome, watch?.kind);
  const Icon = TONE_ICON[tone];
  return (
    <div
      className={cn("flex items-start gap-2 rounded-r-md border-l-2 px-3 py-2", TONE_FRAME[tone])}
    >
      <Icon className={cn("mt-0.5 size-4 shrink-0", TONE_ICON_COLOR[tone])} />
      <div className="min-w-0">
        <p className="text-sm font-medium text-text-bright">{headlineFor(tone, outcome)}</p>
        <p className="truncate text-xs text-text-dimmed">{subline(watch)}</p>
      </div>
    </div>
  );
}
