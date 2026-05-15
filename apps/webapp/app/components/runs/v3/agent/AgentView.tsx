import type { UIMessage } from "@ai-sdk/react";
import { SSEStreamSubscription } from "@trigger.dev/core/v3";
import { useEffect, useMemo, useRef, useState } from "react";
import { Paragraph } from "~/components/primitives/Paragraph";
import { Spinner } from "~/components/primitives/Spinner";
import { AgentMessageView } from "~/components/runs/v3/agent/AgentMessageView";
import { useAutoScrollToBottom } from "~/hooks/useAutoScrollToBottom";
import { useEnvironment } from "~/hooks/useEnvironment";
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";

export type AgentViewAuth = {
  publicAccessToken: string;
  apiOrigin: string;
  /**
   * Session identifier the AgentView uses to address the backing
   * {@link Session} when subscribing to `.in` / `.out`. Accepts either
   * a `session_*` friendlyId or the transport-supplied externalId
   * (typically the browser's `chatId`) — the dashboard resource route
   * resolves either form via `resolveSessionByIdOrExternalId`.
   */
  sessionId: string;
  /**
   * User messages extracted from the run's task payload at load time.
   * Empty array for runs started with `trigger: "preload"` — in that
   * case the first user message arrives over the session's `.in`
   * channel and is merged in by the AgentView subscription.
   */
  initialMessages: UIMessage[];
};

/**
 * Max state-update interval while assistant chunks are streaming. Matches
 * the `experimental_throttle: 100` we previously passed to `useChat`.
 * Chunks mutate a staging ref synchronously; a throttled flush copies the
 * ref into React state at most ~10x/sec so tool-call Prism highlighting
 * etc. doesn't re-run on every single text-delta.
 */
const STATE_FLUSH_THROTTLE_MS = 100;

/**
 * Sentinel timestamp for messages that came from the run's initial task
 * payload — they predate any stream activity, so 0 guarantees they sort
 * first regardless of stream race order.
 */
const INITIAL_PAYLOAD_TIMESTAMP = 0;

/**
 * Renders a Session's chat conversation as it unfolds.
 *
 * Subscribes to both channels of the {@link Session}:
 * - **`.out`** delivers assistant `UIMessageChunk`s (text deltas, tool
 *   calls, reasoning, etc.) produced by the agent's
 *   `chatStream.writer(...)` calls — objects, already parsed by the S2
 *   SSE reader.
 * - **`.in`** delivers {@link ChatInputChunk}s sent by
 *   {@link TriggerChatTransport} (or any other session writer). Each
 *   chunk is a tagged union (`{kind: "message", payload}` for user
 *   turns, `{kind: "stop"}` for stop signals) — the AgentView only
 *   cares about `kind: "message"` and pulls `.payload.messages`.
 *
 * Both streams are read directly via `SSEStreamSubscription` through the
 * dashboard's session-authed resource routes — not through `useChat` or
 * `TriggerChatTransport`. This gives us per-chunk server-side timestamps
 * (S2 sequence numbers) from both streams, which we use to produce a
 * chronologically correct merged message list that works for replays,
 * multi-message turns, cross-run session resumes, and steering messages.
 *
 * Intended to be mounted inside a scrollable container — the component
 * does not own its own scrollbar.
 */
export function AgentView({ agentView }: { agentView: AgentViewAuth }) {
  const organization = useOrganization();
  const project = useProject();
  const environment = useEnvironment();

  const messages = useAgentSessionMessages({
    sessionId: agentView.sessionId,
    apiOrigin: agentView.apiOrigin,
    orgSlug: organization.slug,
    projectSlug: project.slug,
    envSlug: environment.slug,
    initialMessages: agentView.initialMessages,
  });

  // Sticky-bottom auto-scroll: walks up to find the inspector's scroll
  // container, then scrolls to bottom whenever `messages` changes — but
  // only if the user was at (or near) the bottom at the time. Scrolling
  // away pauses auto-scroll; scrolling back resumes it.
  const rootRef = useAutoScrollToBottom([messages]);

  return (
    <div ref={rootRef} className="py-3">
      {messages.length === 0 ? (
        <div className="flex h-full min-h-[12rem] items-center justify-center">
          <div className="flex flex-col items-center gap-3">
            <Spinner className="size-5" color="muted" />
            <Paragraph variant="small" className="text-text-dimmed">
              Loading conversation…
            </Paragraph>
          </div>
        </div>
      ) : (
        <AgentMessageView messages={messages} />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// useAgentSessionMessages — reads both realtime streams for a session and
// maintains a chronologically ordered, merged message list.
// ---------------------------------------------------------------------------

/**
 * Shape of each chunk on the session's `.in` channel. Mirrors the
 * `ChatInputChunk` tagged union produced by {@link TriggerChatTransport}:
 * - `kind: "message"` carries a `ChatTaskWirePayload` in `.payload`
 *   (user-submitted messages or regenerate calls); we dedupe by id.
 * - `kind: "stop"` is a stop signal — no messages, nothing to render
 *   here, so it's filtered.
 *
 * The server wraps records in `{data, id}` and writes `data` as a JSON
 * string; SSE v2 delivers the parsed string back. {@link parseChunkPayload}
 * re-parses to recover the object.
 */
type InputStreamChunk = {
  kind?: "message" | "stop";
  payload?: {
    messages?: Array<{ id?: string; role?: string; parts?: unknown[] }>;
    trigger?: string;
  };
  message?: string;
};

/**
 * Minimal typing for the chunks we care about on the chat output stream.
 * Covers the AI SDK `UIMessageChunk` variants that `renderPart` actually
 * knows how to display, plus the Trigger.dev control chunks that we filter.
 */
type OutputChunk = { type: string; [key: string]: unknown };

/**
 * Per-message orchestration state for the output stream accumulator. Mirrors
 * the active-part tracking that AI SDK's `processUIMessageStream` keeps in
 * its `state` object: a registry of streaming text/reasoning parts so deltas
 * can be matched to the right part by id, plus a way to clear them at step
 * boundaries (`finish-step`) so the next step's `text-start`/`reasoning-start`
 * with the same id starts a fresh part instead of appending to the previous
 * step's part.
 */
/**
 * Per-message orchestration state — index-based active-part tracking.
 *
 * Each map points from a part id (text or reasoning) to **the index of the
 * currently-streaming part with that id in `message.parts`**. We need
 * indexes (not just a `Set` of "active ids") because part ids are *only
 * unique within a step*: the SDK happily reuses `text-start id="0"` after
 * a `finish-step` boundary. Without index tracking, a `text-delta` for the
 * reused id would have to find the right part by id alone — and a search
 * would match BOTH the previous step's frozen part and the current step's
 * fresh one, which produces a duplication where the previous text gets
 * the new content appended to it AND a fresh part with the same content
 * also appears.
 *
 * Mirrors AI SDK's `processUIMessageStream`'s `state.activeTextParts` /
 * `state.activeReasoningParts` (which hold direct references in the
 * mutating canonical impl). We use indexes here because we do immutable
 * updates and need indices that survive `parts.map()` rewrites — adding
 * new parts and updating existing ones never reorders, so an index is
 * stable for the lifetime of the part.
 */
type MessageOrchestrationState = {
  activeTextPartIndexes: Map<string, number>;
  activeReasoningPartIndexes: Map<string, number>;
};

/**
 * `SSEStreamSubscription`'s v2 batch path delivers `parsedBody.data` as-is
 * — but session channels diverge by direction:
 *
 * - `.in`: {@link TriggerChatTransport.serializeInputChunk} writes the
 *   `ChatInputChunk` as a JSON **string**, so `data` is a string that
 *   needs a second `JSON.parse` to recover the tagged union.
 * - `.out`: the agent's `chatStream.writer(...)` writes
 *   {@link UIMessageChunk} **objects** directly; `data` arrives
 *   already-parsed.
 *
 * This helper accepts both shapes defensively: a string is parsed; an
 * object is returned as-is. Returns `null` for unparseable payloads.
 */
function parseChunkPayload(raw: unknown): Record<string, unknown> | null {
  if (raw == null) return null;
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  }
  if (typeof raw === "object") return raw as Record<string, unknown>;
  return null;
}

function createOrchestrationState(): MessageOrchestrationState {
  return {
    activeTextPartIndexes: new Map(),
    activeReasoningPartIndexes: new Map(),
  };
}

function useAgentSessionMessages({
  sessionId,
  apiOrigin,
  orgSlug,
  projectSlug,
  envSlug,
  initialMessages,
}: {
  sessionId: string;
  apiOrigin: string;
  orgSlug: string;
  projectSlug: string;
  envSlug: string;
  initialMessages: UIMessage[];
}): UIMessage[] {
  // Seed with the user messages from the run's task payload.
  const seedMessages = useMemo(
    () => initialMessages.filter((m) => m.role === "user"),
    [initialMessages]
  );

  // `pendingRef` is the authoritative, eagerly-updated message state:
  // chunks mutate this synchronously as they arrive. A throttled flush
  // copies it into React state so UI updates are capped at ~10x/sec.
  const pendingRef = useRef<Map<string, UIMessage>>(
    new Map(seedMessages.map((m) => [m.id, m]))
  );
  const timestampsRef = useRef<Map<string, number>>(
    new Map(seedMessages.map((m) => [m.id, INITIAL_PAYLOAD_TIMESTAMP]))
  );
  // Side-table of orchestration state, keyed by assistant message id. Lives
  // outside the UIMessage so React doesn't see it as a renderable prop.
  const orchestrationRef = useRef<Map<string, MessageOrchestrationState>>(new Map());

  // React state snapshot of pendingRef. Only updated via the throttled
  // `scheduleFlush`. The Map *reference* changes on every flush so React
  // detects the state update and the downstream `useMemo` recomputes.
  const [messagesById, setMessagesById] = useState<Map<string, UIMessage>>(
    () => new Map(pendingRef.current)
  );

  // Throttled flush scheduler — leading edge within a single throttle
  // window: the first chunk after a quiet period flushes immediately, then
  // subsequent chunks coalesce until the next window opens.
  const lastFlushAtRef = useRef<number>(0);
  const pendingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scheduleFlush = useRef<() => void>(() => {});
  scheduleFlush.current = () => {
    if (pendingTimerRef.current !== null) return; // already scheduled
    const now = Date.now();
    const sinceLast = now - lastFlushAtRef.current;
    const delay = Math.max(0, STATE_FLUSH_THROTTLE_MS - sinceLast);
    pendingTimerRef.current = setTimeout(() => {
      pendingTimerRef.current = null;
      lastFlushAtRef.current = Date.now();
      setMessagesById(new Map(pendingRef.current));
    }, delay);
  };

  useEffect(() => {
    const abort = new AbortController();

    const encodedSession = encodeURIComponent(sessionId);
    // Always use the page's own origin to avoid CORS preflight failures
    // when the configured `apiOrigin` (e.g. `localhost`) differs from the
    // origin the dashboard was loaded from (e.g. `127.0.0.1`). The dashboard
    // resource route is same-origin by construction.
    const origin = typeof window !== "undefined" ? window.location.origin : apiOrigin;
    const sessionBase =
      `${origin}/resources/orgs/${orgSlug}/projects/${projectSlug}/env/${envSlug}` +
      `/sessions/${encodedSession}/realtime/v1`;

    const outputUrl = `${sessionBase}/out`;
    const inputUrl = `${sessionBase}/in`;

    const commonSubOptions = {
      signal: abort.signal,
      timeoutInSeconds: 120,
    } as const;

    // ---- Output stream: assistant messages ---------------------------------
    //
    // The output stream delivers UIMessageChunks interleaved with
    // Trigger-specific control chunks (`trigger:turn-complete`, etc.). We
    // filter the control chunks and fold everything else into an assistant
    // `UIMessage` via our own `applyOutputChunk` accumulator — the AI SDK's
    // `readUIMessageStream` helper is only available in `ai@6`, and the
    // webapp is pinned to `ai@4`, so we re-implement just the chunk types
    // that `renderPart` actually displays.
    //
    // We capture the **server timestamp of each assistant message's first
    // `start` chunk** so later sort-by-timestamp merges with the input
    // stream correctly.
    const runOutput = async () => {
      try {
        const sub = new SSEStreamSubscription(outputUrl, commonSubOptions);
        const raw = await sub.subscribe();
        const reader = raw.getReader();

        let currentMessageId: string | null = null;

        try {
          while (!abort.signal.aborted) {
            const { done, value } = await reader.read();
            if (done) return;

            const chunk = parseChunkPayload(value.chunk) as OutputChunk | null;
            if (!chunk || typeof chunk.type !== "string") continue;
            if (chunk.type.startsWith("trigger:")) continue;

            if (chunk.type === "start") {
              const messageId =
                typeof chunk.messageId === "string" && chunk.messageId.length > 0
                  ? chunk.messageId
                  : `asst-${crypto.randomUUID()}`;
              currentMessageId = messageId;

              if (!timestampsRef.current.has(messageId)) {
                timestampsRef.current.set(messageId, value.timestamp);
              }

              const existing = pendingRef.current.get(messageId);
              if (existing) {
                // Same message id seen again — merge metadata only, keep
                // existing parts (canonical `processUIMessageStream` does
                // the same on a repeated `start`).
                if (chunk.messageMetadata != null) {
                  pendingRef.current.set(messageId, {
                    ...existing,
                    metadata: {
                      ...((existing as { metadata?: Record<string, unknown> }).metadata ?? {}),
                      ...(chunk.messageMetadata as Record<string, unknown>),
                    },
                  } as UIMessage);
                  scheduleFlush.current();
                }
              } else {
                const message: UIMessage = {
                  id: messageId,
                  role: "assistant",
                  parts: [],
                  ...(chunk.messageMetadata != null
                    ? { metadata: chunk.messageMetadata as UIMessage["metadata"] }
                    : {}),
                } as UIMessage;
                pendingRef.current.set(messageId, message);
                orchestrationRef.current.set(messageId, createOrchestrationState());
                scheduleFlush.current();
              }
              continue;
            }

            if (currentMessageId === null) continue;
            const existing = pendingRef.current.get(currentMessageId);
            if (!existing) continue;
            let orchestration = orchestrationRef.current.get(currentMessageId);
            if (!orchestration) {
              // Defensive: a chunk arrived for a message we never saw a
              // `start` for. Lazily create orchestration state so we can
              // still display the parts.
              orchestration = createOrchestrationState();
              orchestrationRef.current.set(currentMessageId, orchestration);
            }

            const updated = applyOutputChunk(existing, chunk, orchestration);
            if (updated !== existing) {
              pendingRef.current.set(currentMessageId, updated);
              scheduleFlush.current();
            }
          }
        } finally {
          try {
            reader.releaseLock();
          } catch {
            // Lock may already be released.
          }
        }
      } catch (err) {
        if (abort.signal.aborted) return;
        // eslint-disable-next-line no-console
        console.debug("[AgentView] output stream subscription failed", err);
      }
    };

    // ---- Input channel: user messages (`ChatInputChunk`) -------------------
    //
    // The transport appends a `{kind: "message", payload}` ChatInputChunk
    // for every user turn (and `{kind: "stop"}` for stop signals). We pull
    // user messages out of `payload.messages` for `kind: "message"` chunks
    // and ignore the rest.
    const runInput = async () => {
      try {
        const sub = new SSEStreamSubscription(inputUrl, commonSubOptions);
        const raw = await sub.subscribe();
        const reader = raw.getReader();
        try {
          while (!abort.signal.aborted) {
            const { done, value } = await reader.read();
            if (done) return;

            const chunk = parseChunkPayload(value.chunk) as InputStreamChunk | null;
            if (!chunk || chunk.kind !== "message") continue;
            const payload = chunk.payload;
            if (!payload || !Array.isArray(payload.messages)) continue;

            const incomingUsers = payload.messages.filter(
              (m): m is UIMessage =>
                m != null && (m as { role?: string }).role === "user" && typeof m.id === "string"
            );
            if (incomingUsers.length === 0) continue;

            let changed = false;
            for (const msg of incomingUsers) {
              if (pendingRef.current.has(msg.id)) continue;
              pendingRef.current.set(msg.id, msg);
              timestampsRef.current.set(msg.id, value.timestamp);
              changed = true;
            }
            if (changed) scheduleFlush.current();
          }
        } finally {
          try {
            reader.releaseLock();
          } catch {
            // Lock may already be released.
          }
        }
      } catch (err) {
        if (abort.signal.aborted) return;
        // eslint-disable-next-line no-console
        console.debug("[AgentView] input stream subscription failed", err);
      }
    };

    void runOutput();
    void runInput();

    return () => {
      abort.abort();
      if (pendingTimerRef.current !== null) {
        clearTimeout(pendingTimerRef.current);
        pendingTimerRef.current = null;
      }
    };
  }, [sessionId, apiOrigin, orgSlug, projectSlug, envSlug]);

  return useMemo(() => {
    const timestamps = timestampsRef.current;
    const arr = Array.from(messagesById.values());
    arr.sort((a, b) => {
      const ta = timestamps.get(a.id) ?? 0;
      const tb = timestamps.get(b.id) ?? 0;
      if (ta !== tb) return ta - tb;
      // Tie-breaker for messages sharing a stream ID bucket (rare): fall
      // back to message id string order so the output is deterministic.
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
    return arr;
  }, [messagesById]);
}

// ---------------------------------------------------------------------------
// applyOutputChunk — minimal UIMessageChunk → UIMessage accumulator.
// ---------------------------------------------------------------------------
//
// A pared-down re-implementation of AI SDK's `processUIMessageStream` (in
// `ai@6`'s `index.mjs`). The webapp is pinned to `ai@4`, which doesn't ship
// the v5+ chunk-stream helpers, so we vendor the bits we actually use.
//
// Scope vs. canonical:
// - We render only the chunk shapes that `AgentMessageView`/`renderPart`
//   actually display: text, reasoning, tool-* (input-{start,delta,available}
//   + output-{available,error}), source-url, source-document, file,
//   step-start/finish-step, data-*, plus metadata/finish lifecycle.
// - Unknown chunk types fall through as no-ops — defensive on purpose for a
//   read-only viewer.
// - We **do not parse partial JSON for streaming tool inputs.** Canonical
//   uses `parsePartialJson` (which depends on a 300-line `fixJson` state
//   machine to repair incomplete JSON) so users see the input growing
//   character-by-character. We skip it: tool inputs stay `undefined`
//   throughout streaming and snap to the final value when
//   `tool-input-available` lands. Acceptable for a viewer; can be added
//   later by vendoring `fixJson` if the UX warrants it.
//
// `orchestration` carries per-message active-part trackers that mirror
// canonical's `state.activeTextParts` / `state.activeReasoningParts`. They
// let `text-delta` find the right text part by id and let `finish-step`
// clear them so a new step can re-use the same id without colliding.
//
// Returns the same object reference when nothing changes so the caller can
// skip unnecessary state flushes + React re-renders.

type AnyPart = { [key: string]: unknown; type: string };

function applyOutputChunk(
  msg: UIMessage,
  chunk: OutputChunk,
  orchestration: MessageOrchestrationState
): UIMessage {
  const type = chunk.type;

  // Text parts ---------------------------------------------------------------
  //
  // Track each streaming text part by its index in `msg.parts`. Part ids
  // are only unique *within a step* — the SDK happily reuses `text-start
  // id="0"` after a `finish-step` boundary — so a delta arriving for a
  // reused id needs to land on the *current* part, not every prior part
  // that ever shared that id. The index map gives us O(1) "which slot is
  // currently streaming this id" without any id-based search.
  if (type === "text-start") {
    const id = chunk.id as string;
    const newIndex = (msg.parts ?? []).length; // index AFTER push
    orchestration.activeTextPartIndexes.set(id, newIndex);
    return withNewPart(msg, {
      type: "text",
      id,
      text: "",
      state: "streaming",
    });
  }
  if (type === "text-delta") {
    const id = chunk.id as string;
    const index = orchestration.activeTextPartIndexes.get(id);
    if (index === undefined) return msg; // delta with no start — drop.
    return updatePartAt(msg, index, (p) => ({
      ...p,
      text: ((p as { text?: string }).text ?? "") + String(chunk.delta ?? ""),
    }));
  }
  if (type === "text-end") {
    const id = chunk.id as string;
    const index = orchestration.activeTextPartIndexes.get(id);
    if (index === undefined) return msg;
    orchestration.activeTextPartIndexes.delete(id);
    return updatePartAt(msg, index, (p) => ({ ...p, state: "done" }));
  }

  // Reasoning parts ----------------------------------------------------------
  if (type === "reasoning-start") {
    const id = chunk.id as string;
    const newIndex = (msg.parts ?? []).length;
    orchestration.activeReasoningPartIndexes.set(id, newIndex);
    return withNewPart(msg, {
      type: "reasoning",
      id,
      text: "",
      state: "streaming",
    });
  }
  if (type === "reasoning-delta") {
    const id = chunk.id as string;
    const index = orchestration.activeReasoningPartIndexes.get(id);
    if (index === undefined) return msg;
    return updatePartAt(msg, index, (p) => ({
      ...p,
      text: ((p as { text?: string }).text ?? "") + String(chunk.delta ?? ""),
    }));
  }
  if (type === "reasoning-end") {
    const id = chunk.id as string;
    const index = orchestration.activeReasoningPartIndexes.get(id);
    if (index === undefined) return msg;
    orchestration.activeReasoningPartIndexes.delete(id);
    return updatePartAt(msg, index, (p) => ({ ...p, state: "done" }));
  }

  // Tool call parts ----------------------------------------------------------
  if (type === "tool-input-start") {
    const toolName = String(chunk.toolName ?? "");
    return withNewPart(msg, {
      type: `tool-${toolName}`,
      toolCallId: chunk.toolCallId,
      toolName,
      state: "input-streaming",
      input: undefined,
    });
  }
  if (type === "tool-input-delta") {
    // We don't parse partial JSON, so streaming tool input deltas are a
    // no-op. The full input snaps in when `tool-input-available` arrives.
    return msg;
  }
  if (type === "tool-input-available") {
    const toolName = String(chunk.toolName ?? "");
    const existingIdx = indexOfPart(
      msg,
      (p) => (p as { toolCallId?: string }).toolCallId === chunk.toolCallId
    );
    if (existingIdx >= 0) {
      return updatePartAt(msg, existingIdx, (p) => ({
        ...p,
        state: "input-available",
        input: chunk.input,
      }));
    }
    // Tool input arrived without a preceding tool-input-start (some
    // providers do this for fast tools) — synthesize a new part.
    return withNewPart(msg, {
      type: `tool-${toolName}`,
      toolCallId: chunk.toolCallId,
      toolName,
      state: "input-available",
      input: chunk.input,
    });
  }
  if (type === "tool-output-available") {
    return updatePart(msg, (p) =>
      (p as { toolCallId?: string }).toolCallId === chunk.toolCallId
        ? {
            ...p,
            state: "output-available",
            output: chunk.output,
            ...(chunk.preliminary === true ? { preliminary: true } : {}),
          }
        : null
    );
  }
  if (type === "tool-output-error") {
    return updatePart(msg, (p) =>
      (p as { toolCallId?: string }).toolCallId === chunk.toolCallId
        ? { ...p, state: "output-error", errorText: chunk.errorText }
        : null
    );
  }

  // Source / file / step / data parts — pass through as a whole -------------
  if (type === "source-url" || type === "source-document" || type === "file") {
    return withNewPart(msg, chunk as unknown as AnyPart);
  }
  if (type === "start-step") {
    return withNewPart(msg, { type: "step-start" });
  }
  if (type === "finish-step") {
    // Step boundary — canonical clears the active part trackers so a new
    // step can re-use the same text/reasoning part IDs cleanly. The
    // message itself doesn't structurally change; the previous step's
    // parts stay frozen at their indexes in `msg.parts`.
    orchestration.activeTextPartIndexes.clear();
    orchestration.activeReasoningPartIndexes.clear();
    return msg;
  }
  if (type.startsWith("data-")) {
    return withNewPart(msg, chunk as unknown as AnyPart);
  }

  // Metadata / lifecycle -----------------------------------------------------
  if (type === "finish" || type === "message-metadata") {
    if (chunk.messageMetadata == null) return msg;
    return {
      ...msg,
      metadata: {
        ...((msg as { metadata?: Record<string, unknown> }).metadata ?? {}),
        ...(chunk.messageMetadata as Record<string, unknown>),
      },
    } as UIMessage;
  }

  // Abort / error / unknown — no structural change. (`start` is handled at
  // the orchestration level in the output reader, not here.)
  return msg;
}

// --- Small immutable helpers for UIMessage.parts mutation -------------------

function withNewPart(msg: UIMessage, part: AnyPart): UIMessage {
  return {
    ...msg,
    parts: [...((msg.parts ?? []) as AnyPart[]), part],
  } as UIMessage;
}

function updatePart(
  msg: UIMessage,
  updater: (part: AnyPart) => AnyPart | null
): UIMessage {
  const parts = (msg.parts ?? []) as AnyPart[];
  let changed = false;
  const next = parts.map((p) => {
    const updated = updater(p);
    if (updated === null) return p;
    changed = true;
    return updated;
  });
  return changed ? ({ ...msg, parts: next } as UIMessage) : msg;
}

function indexOfPart(msg: UIMessage, predicate: (part: AnyPart) => boolean): number {
  const parts = (msg.parts ?? []) as AnyPart[];
  for (let i = 0; i < parts.length; i++) {
    if (predicate(parts[i]!)) return i;
  }
  return -1;
}

function updatePartAt(
  msg: UIMessage,
  index: number,
  updater: (part: AnyPart) => AnyPart
): UIMessage {
  const parts = (msg.parts ?? []) as AnyPart[];
  if (index < 0 || index >= parts.length) return msg;
  const next = parts.slice();
  next[index] = updater(parts[index]!);
  return { ...msg, parts: next } as UIMessage;
}
