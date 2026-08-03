/**
 * What the ONE live progress line says.
 *
 * A turn shows a single progress element, mounted once at the bottom of the
 * transcript for the whole in-flight period (see `DashboardAgentTurns`). Only its
 * LABEL changes as the turn moves through phases — the element itself is never
 * unmounted, because its spinner is an animated canvas that would restart from
 * frame one on every remount.
 *
 * The phases used to own their own line each (a tool's pending pill, the generic
 * activity row, the investigation card's progress row), which is exactly what made
 * the spinner reset three times a turn. This module is the whole decision instead:
 * given the transcript and the turn's activity, which phrase wins.
 *
 * Priority, most specific first:
 *
 *  1. `investigation` — a live investigation card is on screen; the agent wrote
 *     its own phrase for what it is doing right now ("Testing hypothesis 2…").
 *  2. `tool` — a tool call is in flight; the phrase names the work
 *     ("Reading the queue…").
 *  3. `activity` — nothing more specific to say: "Thinking…" / "Working…".
 *
 * Nothing in flight and no live card is the only case with no line at all.
 */
import { toolPendingLabel } from "./tool-labels";

/** A tool call that hasn't produced output yet, so it is still work in progress. */
export const IN_FLIGHT_TOOL_STATES = new Set(["input-streaming", "input-available"]);

// "thinking" — the turn is submitted but nothing has come back yet.
// "working" — the turn is streaming: text, or (more often) tool calls, which can
// run for a while with no visible output.
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
 * The investigation blocks a part carries, in order.
 *
 * An investigation only ever reaches the panel through `render_view`'s output, so
 * that is the only place worth looking — no need for the card adapters here.
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
 * Latest-revision-wins, exactly like the card the transcript renders (see
 * `winningInvestigationOccurrences`): an investigation is re-emitted as it
 * progresses, so an early `in_progress` revision must not keep a progress line up
 * after the verdict has landed. With several investigations live, the last one in
 * the transcript is the one the reader is watching.
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
 * The label for the turn's one progress element, or null when there is nothing in
 * flight and so nothing to show.
 *
 * Being non-null is what mounts the element and being null is what unmounts it —
 * so this must stay non-null for the whole in-flight period, whichever phase the
 * turn is in. That is why a live card and an in-flight tool each keep the line up
 * on their own, without needing `activity`: a phase whose signal hadn't arrived
 * yet would blink the spinner out and back in.
 */
export function liveProgress(
  messages: ReadonlyArray<ProgressMessage>,
  activity: TurnActivity | null
): LiveProgress | null {
  const investigation = liveInvestigation(messages);
  if (investigation) {
    return {
      source: "investigation",
      // A card without its own phrase still says more than nothing: fall back to
      // the generic wording rather than to an empty line.
      label: investigation.progress ?? ACTIVITY_LABELS[activity ?? "working"],
    };
  }

  const tool = inFlightToolName(messages);
  if (tool) return { source: "tool", label: `${toolPendingLabel(tool)}…` };

  if (activity) return { source: "activity", label: ACTIVITY_LABELS[activity] };

  return null;
}
