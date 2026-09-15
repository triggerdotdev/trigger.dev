import { activeTurnMessage } from "./active-turn";
import { toolPendingLabel } from "./tool-labels";

/** A tool call with no output yet. */
export const IN_FLIGHT_TOOL_STATES = new Set(["input-streaming", "input-available"]);

// "thinking": submitted, nothing back yet. "working": streaming text or tool calls.
export type TurnActivity = "thinking" | "working";

const ACTIVITY_LABELS: Record<TurnActivity, string> = {
  thinking: "Thinking…",
  working: "Working…",
};

type ProgressSource = "investigation" | "tool" | "activity";

export type LiveProgress = { source: ProgressSource; label: string };

/** Duck-typed: this module reads a transcript, it doesn't own one. */
type ProgressPart = {
  type?: string;
  state?: string;
  toolCallId?: string;
  output?: { blocks?: ReadonlyArray<unknown> };
};

type ProgressMessage = { id?: string; role?: string; parts?: ReadonlyArray<unknown> };

type LiveInvestigation = { progress: string | null };

function partsOf(message: ProgressMessage | undefined): ReadonlyArray<ProgressPart> {
  return (message?.parts ?? []) as ReadonlyArray<ProgressPart>;
}

/** An investigation only reaches the panel through `render_view`'s output. */
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

/** Latest revision wins: an early `in_progress` must not outlive the verdict. */
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

export type InFlightToolCall = { callId: string; name: string };

/**
 * In-flight tool call parts of the turn's own message, in emission order.
 *
 * `activeTurnMessage`, not the literal last one: a watch wake landing mid-turn would
 * otherwise hide the call a hang deadline is timing.
 */
function inFlightToolCallsInActiveTurn(
  messages: ReadonlyArray<ProgressMessage>
): { callId: string | undefined; name: string }[] {
  const active = activeTurnMessage(messages);
  if (!active || active.role !== "assistant") return [];

  const calls: { callId: string | undefined; name: string }[] = [];
  for (const part of partsOf(active)) {
    if (
      typeof part?.type === "string" &&
      part.type.startsWith("tool-") &&
      IN_FLIGHT_TOOL_STATES.has(part.state ?? "")
    ) {
      calls.push({ callId: part.toolCallId, name: part.type.slice("tool-".length) });
    }
  }
  return calls;
}

/** Only the turn's own message counts; an in-flight part in an earlier turn is stale. */
export function inFlightToolName(messages: ReadonlyArray<ProgressMessage>): string | null {
  const calls = inFlightToolCallsInActiveTurn(messages);
  return calls.length ? calls[calls.length - 1].name : null;
}

/**
 * The earliest still-pending tool call in the turn's own message (emission order:
 * the first part wins). Used to key a hang deadline: the earliest call is the one
 * actually at risk of exceeding it, and its id keeps the timer stable even after a
 * *sibling* call started at the same time settles first (or a same-named call replaces
 * it) — a tool-name key would falsely restart the window in either case.
 */
export function earliestInFlightToolCall(
  messages: ReadonlyArray<ProgressMessage>
): InFlightToolCall | undefined {
  const call = inFlightToolCallsInActiveTurn(messages).find(
    (candidate): candidate is { callId: string; name: string } =>
      typeof candidate.callId === "string"
  );
  return call;
}

/** A prose-only turn has no tool part to catch; a `text` part mid-stream has `state: "streaming"`. */
export function hasUnfinishedTextPart(messages: ReadonlyArray<ProgressMessage>): boolean {
  const active = activeTurnMessage(messages);
  if (!active || active.role !== "assistant") return false;
  return partsOf(active).some((part) => part?.type === "text" && part.state === "streaming");
}

/** Must stay non-null for the whole in-flight period: null unmounts, and a gap blinks. */
export function liveProgress(
  messages: ReadonlyArray<ProgressMessage>,
  activity: TurnActivity | null
): LiveProgress | null {
  const investigation = liveInvestigation(messages);
  if (investigation) {
    return {
      source: "investigation",
      label: investigation.progress ?? ACTIVITY_LABELS[activity ?? "working"],
    };
  }

  const tool = inFlightToolName(messages);
  if (tool) return { source: "tool", label: `${toolPendingLabel(tool)}…` };

  if (activity) return { source: "activity", label: ACTIVITY_LABELS[activity] };

  return null;
}
