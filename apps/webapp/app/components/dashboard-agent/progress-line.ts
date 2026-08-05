/**
 * What the one live progress line says.
 *
 * A turn shows a single progress element, mounted once at the bottom of the
 * transcript for the whole in-flight period (see `DashboardAgentTurns`). Only its
 * label changes between phases: its spinner is an animated canvas that restarts
 * from frame one on every remount.
 *
 * Label priority, most specific first: a live investigation card's own phrase, an
 * in-flight tool's phrase, then the generic activity wording.
 */
import { toolPendingLabel } from "./tool-labels";

/** A tool call that hasn't produced output yet, so it is still work in progress. */
export const IN_FLIGHT_TOOL_STATES = new Set(["input-streaming", "input-available"]);

// "thinking": submitted, nothing back yet. "working": streaming text or tool
// calls, which can run a while with no visible output.
export type TurnActivity = "thinking" | "working";

export const ACTIVITY_LABELS: Record<TurnActivity, string> = {
  thinking: "Thinking…",
  working: "Working…",
};

/** Which phase wrote the label. The rendered element is the same either way. */
export type ProgressSource = "investigation" | "tool" | "activity";

export type LiveProgress = { source: ProgressSource; label: string };

/** Duck-typed message/part shapes: this module reads a transcript, it doesn't own one. */
type ProgressPart = {
  type?: string;
  state?: string;
  output?: { blocks?: ReadonlyArray<unknown> };
};

type ProgressMessage = { role?: string; parts?: ReadonlyArray<unknown> };

type LiveInvestigation = { progress: string | null };

function partsOf(message: ProgressMessage | undefined): ReadonlyArray<ProgressPart> {
  return (message?.parts ?? []) as ReadonlyArray<ProgressPart>;
}

/**
 * The investigation blocks a part carries, in order. An investigation only reaches
 * the panel through `render_view`'s output, so that is the only place to look.
 */
function investigationBlocksIn(part: ProgressPart): ReadonlyArray<{
  id: string;
  revision: number;
  outcome?: string;
  progress?: string;
}> {
  if (part?.type !== "tool-render_view") return [];
  const blocks = part.output?.blocks;
  if (!Array.isArray(blocks)) return [];
  const found: { id: string; revision: number; outcome?: string; progress?: string }[] = [];
  for (const block of blocks) {
    const b = block as {
      type?: string;
      id?: string;
      revision?: number;
      investigation?: { outcome?: string; progress?: string };
    };
    if (b?.type !== "investigation" || typeof b.id !== "string") continue;
    found.push({
      id: b.id,
      revision: typeof b.revision === "number" ? b.revision : 0,
      outcome: b.investigation?.outcome,
      progress: b.investigation?.progress,
    });
  }
  return found;
}

/**
 * The investigation the transcript is currently showing as unfinished, if any.
 *
 * Latest revision wins, like the card the transcript renders (see
 * `winningInvestigationOccurrences`): an investigation is re-emitted as it
 * progresses, so an early `in_progress` revision must not keep the progress line
 * up after the verdict landed. With several live, the last one mentioned wins.
 */
export function liveInvestigation(
  messages: ReadonlyArray<ProgressMessage>
): LiveInvestigation | null {
  const latest = new Map<string, { revision: number; outcome?: string; progress?: string }>();
  const order: string[] = [];

  for (const message of messages) {
    for (const part of partsOf(message)) {
      for (const block of investigationBlocksIn(part)) {
        const current = latest.get(block.id);
        if (!current || block.revision >= current.revision) {
          latest.set(block.id, block);
        }
        // Recency by last mention, so the card the reader saw most recently wins.
        const seen = order.indexOf(block.id);
        if (seen !== -1) order.splice(seen, 1);
        order.push(block.id);
      }
    }
  }

  for (const id of [...order].reverse()) {
    const block = latest.get(id);
    if (block?.outcome === "in_progress") {
      return { progress: block.progress ?? null };
    }
  }
  return null;
}

/**
 * The tool the last turn is waiting on, or null.
 *
 * Only the last assistant message counts — an in-flight part left behind in an
 * earlier turn is stale. With more than one call in flight the most recent wins.
 */
export function inFlightToolName(messages: ReadonlyArray<ProgressMessage>): string | null {
  const last = messages[messages.length - 1];
  if (!last || last.role !== "assistant") return null;

  for (const part of [...partsOf(last)].reverse()) {
    if (
      typeof part?.type === "string" &&
      part.type.startsWith("tool-") &&
      IN_FLIGHT_TOOL_STATES.has(part.state ?? "")
    ) {
      return part.type.slice("tool-".length);
    }
  }
  return null;
}

/**
 * The label for the turn's one progress element, or null when nothing is in flight.
 *
 * Non-null mounts the element and null unmounts it, so this must stay non-null for
 * the whole in-flight period. That is why a live card and an in-flight tool each
 * keep the line up without needing `activity`: a gap would blink the spinner.
 */
export function liveProgress(
  messages: ReadonlyArray<ProgressMessage>,
  activity: TurnActivity | null
): LiveProgress | null {
  const investigation = liveInvestigation(messages);
  if (investigation) {
    return {
      source: "investigation",
      // A card without its own phrase falls back to the generic wording.
      label: investigation.progress ?? ACTIVITY_LABELS[activity ?? "working"],
    };
  }

  const tool = inFlightToolName(messages);
  if (tool) return { source: "tool", label: `${toolPendingLabel(tool)}…` };

  if (activity) return { source: "activity", label: ACTIVITY_LABELS[activity] };

  return null;
}
