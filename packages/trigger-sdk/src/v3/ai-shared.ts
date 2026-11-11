/**
 * Browser-safe primitives shared between `@trigger.dev/sdk/ai` (server) and
 * `@trigger.dev/sdk/chat` / `@trigger.dev/sdk/chat/react` (client).
 *
 * This module exists to keep `ai.ts` reachable only from the server graph.
 * `ai.ts` weighs in at ~7000 lines and statically imports the agent-skills
 * runtime (which uses `node:child_process` / `node:fs/promises`). When a
 * browser bundle imports a runtime value from `ai.ts` — historically the
 * `PENDING_MESSAGE_INJECTED_TYPE` constant in `chat-react.ts` — the bundler
 * traces `ai.ts`'s entire module graph into the client chunk and hits the
 * `node:` builtins, which Turbopack rejects outright (and webpack flags as
 * a "Critical dependency" warning).
 *
 * Anything in this file MUST stay free of `node:*` imports and free of any
 * import from `ai.ts`.
 */

import type { Task, AnyTask } from "@trigger.dev/core/v3";
import type { InferUITools, ToolSet, UIDataTypes, UIMessage } from "ai";

/**
 * Message-part `type` value for the pending-message data part the agent
 * injects when a follow-up message arrives mid-turn.
 */
export const PENDING_MESSAGE_INJECTED_TYPE = "data-pending-message-injected" as const;

/**
 * Message-part `type` value marking where `chat.inject` messages drained
 * mid-turn reached the model. Separate from the pending-message type so
 * clients that render injection markers do not render these.
 */
export const BACKGROUND_INJECTION_TYPE = "data-background-injected" as const;

// Declared in `chat.ts` (a public subpath) so customer declaration emit can
// name them — declaring them here breaks `declaration: true` consumers with
// TS2742, since this module isn't reachable via the package exports map.
import type { ChatTaskWirePayload } from "./chat.js";
export type { ChatTaskWirePayload, ChatInputChunk } from "./chat.js";

/**
 * Extracts the client-data (`metadata`) type from a chat task.
 *
 * @example
 * ```ts
 * import type { InferChatClientData } from "@trigger.dev/sdk/ai";
 * import type { myChat } from "@/trigger/chat";
 *
 * type MyClientData = InferChatClientData<typeof myChat>;
 * ```
 */
export type InferChatClientData<TTask extends AnyTask> =
  TTask extends Task<string, ChatTaskWirePayload<any, infer TMetadata>, any> ? TMetadata : unknown;

/**
 * Extracts the UI message type from a chat task (wire payload `message` items).
 *
 * @example
 * ```ts
 * import type { InferChatUIMessage } from "@trigger.dev/sdk/ai";
 * import type { myChat } from "@/trigger/chat";
 *
 * type Msg = InferChatUIMessage<typeof myChat>;
 * ```
 */
export type InferChatUIMessage<TTask extends AnyTask> =
  TTask extends Task<string, ChatTaskWirePayload<infer TUIM extends UIMessage, any>, any>
    ? TUIM
    : UIMessage;

/**
 * Derive the chat `UIMessage` type for a given tool set. The tool-part types
 * (`tool-${name}` with typed input/output) are inferred from the tools. Use
 * this to declare the message type from your tools (e.g. to pass to
 * `chat.withUIMessage<...>()` or to type the frontend) without hand-writing
 * the `UIMessage<unknown, UIDataTypes, InferUITools<...>>` triple.
 *
 * @example
 * ```ts
 * import type { InferChatUIMessageFromTools } from "@trigger.dev/sdk/ai";
 * const tools = { search, readFile };
 * type ChatUiMessage = InferChatUIMessageFromTools<typeof tools>;
 * ```
 */
export type InferChatUIMessageFromTools<TTools extends ToolSet> = UIMessage<
  unknown,
  UIDataTypes,
  InferUITools<TTools>
>;

/**
 * Upsert an incoming wire message into the customer's DB-backed chain
 * inside a `hydrateMessages` hook. Returns `true` iff the chain was
 * mutated (the caller should persist).
 *
 * Handles the three cases that matter:
 *
 *  - **Non-submit-message trigger** (`regenerate-message` / `action`,
 *    or `submit-message` with no incoming): no-op. Returns `false`.
 *  - **Incoming id already in `stored`** (HITL `addToolOutput` /
 *    `addToolApproveResponse` continuation — the wire carries the
 *    existing assistant's id with a slim resolution payload): no-op.
 *    The runtime's per-turn merge overlays the new tool-state advance
 *    onto the existing entry; pushing again would duplicate the row
 *    in the chain you return, and the duplicate slim copy would hit
 *    `toModelMessages` with no `input`. Returns `false`.
 *  - **Incoming user message whose id is not in `stored`** (a fresh user
 *    message on a new turn): push. Returns `true`. Any other new message is
 *    not something a client can add to the chain, so it is never pushed.
 *
 * Mutates `stored` in place. The caller persists `stored`, not the
 * return value.
 *
 * @example
 * ```ts
 * import { chat, upsertIncomingMessage } from "@trigger.dev/sdk/ai";
 *
 * chat.agent({
 *   hydrateMessages: async ({ chatId, trigger, incomingMessages }) => {
 *     const record = await db.chat.findUnique({ where: { id: chatId } });
 *     const stored = record?.messages ?? [];
 *     if (upsertIncomingMessage(stored, { trigger, incomingMessages })) {
 *       await db.chat.update({ where: { id: chatId }, data: { messages: stored } });
 *     }
 *     return stored;
 *   },
 * });
 * ```
 */
export function upsertIncomingMessage<TMsg extends UIMessage = UIMessage>(
  stored: TMsg[],
  event: {
    trigger: "submit-message" | "regenerate-message" | "action";
    incomingMessages: TMsg[];
  }
): boolean {
  if (event.trigger !== "submit-message") return false;
  if (event.incomingMessages.length === 0) return false;
  const newMsg = event.incomingMessages[event.incomingMessages.length - 1];
  if (!newMsg) return false;
  if (newMsg.role !== "user") return false;
  if (newMsg.id) {
    const existingIdx = stored.findIndex((m) => m.id === newMsg.id);
    if (existingIdx !== -1) return false;
  }
  stored.push(newMsg);
  return true;
}

/**
 * Tool-part states that the client advances and ships back over the wire.
 * Covers HITL `addToolOutput` (output-available / output-error) and the
 * approval flow (approval-responded / output-denied). `input-streaming` /
 * `input-available` / `approval-requested` are server-emitted only — if
 * we see them on the wire we treat them as no-ops and skip the slim/merge.
 */
function isWireAdvanceableToolState(
  state: unknown
): state is "output-available" | "output-error" | "approval-responded" | "output-denied" {
  return (
    state === "output-available" ||
    state === "output-error" ||
    state === "approval-responded" ||
    state === "output-denied"
  );
}

/** Whether a tool-UI part is a static (`tool-${name}`) or dynamic tool. */
function isToolPartType(type: unknown): boolean {
  return typeof type === "string" && (type.startsWith("tool-") || type === "dynamic-tool");
}

/**
 * Slim an outgoing assistant message before it ships on `submit-message`.
 *
 * When the client calls `addToolOutput(...)` to resolve a HITL tool (or
 * `addToolApproveResponse(...)` to approve/deny one), the AI SDK turns
 * it into a `submit-message` whose `messages.at(-1)` is the existing
 * assistant message with the new state stitched onto a single tool
 * part. On a reasoning-heavy multi-step turn, that full assistant
 * message can be 600 KB – 1 MB (encrypted reasoning blobs, reasoning
 * text, full tool `input` JSON, prior tool outputs) — well over the
 * `.in/append` cap.
 *
 * The agent runtime only consumes the wire-advanced fields of those
 * tool parts (state + output / errorText / approval). Everything else
 * (text, reasoning, tool `input`) is rebuilt server-side from the
 * durable snapshot or `hydrateMessages`. So we drop everything but
 * the advanced tool parts here, and reduce those to just the fields
 * the server overlays.
 *
 * The slim only fires when the assistant message carries at least one
 * wire-advanceable tool part. Plain assistant resends (no resolved /
 * approval-responded tool) and non-assistant messages pass through
 * untouched.
 *
 * Pairs with the per-turn merge on the agent side
 * (`mergeIncomingIntoHydrated` in `ai.ts`).
 */
export function slimSubmitMessageForWire<TMsg extends UIMessage | undefined>(message: TMsg): TMsg {
  if (!message) return message;
  if (message.role !== "assistant") return message;
  const parts = (message.parts ?? []) as any[];
  const advancedToolParts = parts.filter(
    (p) =>
      p && typeof p === "object" && isToolPartType(p.type) && isWireAdvanceableToolState(p.state)
  );
  if (advancedToolParts.length === 0) return message;
  return {
    id: message.id,
    role: message.role,
    parts: advancedToolParts.map(slimAdvancedToolPart),
  } as unknown as TMsg;
}

function slimAdvancedToolPart(p: any): Record<string, unknown> {
  const base: Record<string, unknown> = {
    type: p.type,
    toolCallId: p.toolCallId,
    state: p.state,
  };
  if (p.type === "dynamic-tool" && typeof p.toolName === "string") {
    base.toolName = p.toolName;
  }
  if (p.state === "output-available") {
    base.output = p.output;
    if (p.approval !== undefined) base.approval = p.approval;
  } else if (p.state === "output-error") {
    if (p.errorText !== undefined) base.errorText = p.errorText;
    if (p.approval !== undefined) base.approval = p.approval;
  } else if (p.state === "approval-responded" || p.state === "output-denied") {
    if (p.approval !== undefined) base.approval = p.approval;
  }
  return base;
}

/**
 * Reduce a message that arrived from a chat client to what a client can legitimately send.
 *
 * A client sends user messages, and assistant messages only to resolve a tool call the agent made
 * (`addToolApprovalResponse` / `addToolOutput`), in the slim shape `slimSubmitMessageForWire` produces.
 * So a user message loses any tool parts, an assistant message keeps only its resolved tool parts and
 * only the fields the agent overlays (never `input`), and any other message is dropped. A tool part with
 * no `input` is only ever applied as a resolution of a call already in the agent's history; see
 * {@link resolveClientToolResolution}.
 *
 * Returns `undefined` when nothing a client may send is left.
 *
 * @internal
 */
export function sanitizeClientMessage<TMsg extends UIMessage>(message: TMsg): TMsg | undefined {
  if (!message || typeof message !== "object") return undefined;
  const parts = Array.isArray(message.parts) ? (message.parts as any[]) : [];
  if (message.role === "user") {
    const kept = parts.filter((p) => !(p && typeof p === "object" && isToolPartType(p.type)));
    return kept.length === parts.length ? message : ({ ...message, parts: kept } as TMsg);
  }
  if (message.role !== "assistant") return undefined;
  const advanced = parts.filter(
    (p) =>
      p &&
      typeof p === "object" &&
      isToolPartType(p.type) &&
      typeof p.toolCallId === "string" &&
      isWireAdvanceableToolState(p.state)
  );
  if (advanced.length === 0) return undefined;
  return {
    id: message.id,
    role: message.role,
    parts: advanced.map(slimAdvancedToolPart),
  } as unknown as TMsg;
}

/**
 * Reduce first-turn history a chat client sent to `chat.headStart`. A new chat can open with an
 * assistant greeting, so assistant messages keep their text; nothing else from the client can carry a
 * tool call, reasoning or a system prompt into the conversation.
 *
 * @internal
 */
export function sanitizeClientHistory<TMsg extends UIMessage>(messages: readonly TMsg[]): TMsg[] {
  const out: TMsg[] = [];
  for (const message of messages) {
    if (!message || typeof message !== "object") continue;
    if (message.role === "user") {
      const sanitized = sanitizeClientMessage(message);
      if (sanitized) out.push(sanitized);
      continue;
    }
    if (message.role !== "assistant") continue;
    const parts = Array.isArray(message.parts) ? (message.parts as any[]) : [];
    const text = parts.filter((p) => p && typeof p === "object" && p.type === "text");
    if (text.length > 0) {
      out.push({ ...message, parts: text } as TMsg);
    }
  }
  return out;
}

/**
 * Sanitize every client-supplied message on a wire payload. See {@link sanitizeClientMessage}.
 *
 * @internal
 */
export function sanitizeClientWirePayload<TPayload extends ChatTaskWirePayload<any, any>>(
  payload: TPayload
): TPayload {
  if (!payload || typeof payload !== "object") return payload;
  let next = payload;
  if (payload.message !== undefined) {
    const message = sanitizeClientMessage(payload.message as UIMessage);
    if (message !== payload.message) {
      next = { ...next, message };
      if (message === undefined) delete (next as { message?: unknown }).message;
    }
  }
  if (Array.isArray(payload.headStartMessages)) {
    next = {
      ...next,
      headStartMessages: sanitizeClientHistory(payload.headStartMessages as UIMessage[]),
    };
  }
  return next;
}

/**
 * Match a client's tool resolution against the history the agent holds.
 *
 * Each resolved tool part has to answer a call already in `history`: an approval response needs the
 * stored call to be awaiting approval with the same approval id, and a tool output needs the stored call
 * to be awaiting its result. The returned message carries the id of the stored message holding those
 * calls, so it merges onto it whatever id the client gave it. Parts that answer nothing are dropped, and
 * so is the message when none are left.
 *
 * A message with no input-less resolved tool parts is returned unchanged.
 *
 * @internal
 */
export function resolveClientToolResolution<TMsg extends UIMessage>(
  message: TMsg,
  history: readonly UIMessage[]
): TMsg | undefined {
  if (message.role !== "assistant") return message;
  const parts = Array.isArray(message.parts) ? (message.parts as any[]) : [];
  const resolutions = parts.filter(isClientToolResolution);
  if (resolutions.length === 0) return message;

  let targetId: string | undefined;
  const kept: any[] = [];
  for (const part of resolutions) {
    const found = findStoredToolPart(history, part.toolCallId);
    if (!found) continue;
    if (targetId !== undefined && found.messageId !== targetId) continue;
    if (!isAllowedResolution(found.part, part)) continue;
    targetId = found.messageId;
    kept.push(part);
  }
  if (targetId === undefined || kept.length === 0) return undefined;
  return { id: targetId, role: message.role, parts: kept } as unknown as TMsg;
}

function isClientToolResolution(p: any): boolean {
  return (
    !!p &&
    typeof p === "object" &&
    isToolPartType(p.type) &&
    typeof p.toolCallId === "string" &&
    isWireAdvanceableToolState(p.state) &&
    p.input === undefined
  );
}

function findStoredToolPart(
  history: readonly UIMessage[],
  toolCallId: string
): { messageId: string; part: any } | undefined {
  for (let i = history.length - 1; i >= 0; i--) {
    const stored = history[i];
    if (!stored || stored.role !== "assistant") continue;
    for (const part of (stored.parts ?? []) as any[]) {
      if (part && isToolPartType(part.type) && part.toolCallId === toolCallId) {
        return { messageId: stored.id, part };
      }
    }
  }
  return undefined;
}

function isAllowedResolution(stored: any, incoming: any): boolean {
  if (incoming.state === "approval-responded" || incoming.state === "output-denied") {
    return (
      stored.state === "approval-requested" &&
      typeof stored.approval?.id === "string" &&
      stored.approval.id === incoming.approval?.id
    );
  }
  return stored.state === "input-available" || stored.state === "approval-responded";
}

/**
 * Remove answered tool parts that carry neither `input` nor `rawInput` from a history the agent did
 * not build itself, such as the chain a `hydrateMessages` or `loadContext` hook returns. Every call the
 * agent made carries one of the two, so such a part is a client's resolution that was copied into the
 * chain without answering a stored call, and an approved one would otherwise run its tool. Assistant
 * messages left with no parts are dropped.
 *
 * @internal
 */
export function dropUnbackedToolResolutions<TMsg extends UIMessage>(
  messages: readonly TMsg[]
): TMsg[] {
  const out: TMsg[] = [];
  for (const message of messages) {
    if (!message || message.role !== "assistant" || !Array.isArray(message.parts)) {
      out.push(message);
      continue;
    }
    const parts = message.parts as any[];
    const kept = parts.filter((p) => !(isClientToolResolution(p) && p.rawInput === undefined));
    if (kept.length === parts.length) {
      out.push(message);
    } else if (kept.length > 0) {
      out.push({ ...message, parts: kept } as TMsg);
    }
  }
  return out;
}

/** Run tags accept at most 10 entries of at most 128 characters each. */
const MAX_RUN_TAGS = 10;
const MAX_RUN_TAG_LENGTH = 128;

/**
 * Build the run tags for a chat session: the automatic `chat:{chatId}` tag
 * followed by the caller's tags, capped at the run tag limit. The chat tag
 * is skipped when the chat ID is too long to fit within a single tag, so a
 * long ID degrades to "not filterable by chat" rather than failing to start.
 */
export function chatRunTags(chatId: string, userTags: string[] = []): string[] {
  const chatTag = `chat:${chatId}`;
  const tags = chatTag.length <= MAX_RUN_TAG_LENGTH ? [chatTag, ...userTags] : [...userTags];
  return tags.slice(0, MAX_RUN_TAGS);
}

/**
 * A session body that ends without a turn-complete is only terminal when the
 * server says the session settled — otherwise the turn is still running and
 * the connection was lost (long-poll window closed, proxy restarted). Both
 * transports resubscribe from the last event id, bounded so a permanently
 * empty stream can't spin.
 */
export const MAX_EOF_RESUBSCRIBES = 5;

/**
 * Backoff before the nth (1-based) EOF resubscribe, jittered so many clients
 * dropped by the same window don't reconnect in lockstep. Resolves early on
 * abort — otherwise a stop landing mid-backoff leaves the stream open for the
 * rest of it.
 */
export function waitBeforeEofResubscribe(attempt: number, signal: AbortSignal): Promise<void> {
  // An already-aborted signal never fires `abort` again, so a listener added
  // here would wait out the whole backoff.
  if (signal.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    let timer: ReturnType<typeof setTimeout>;
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const backoff = Math.min(100 * 2 ** (attempt - 1), 5_000);
    timer = setTimeout(done, backoff * (0.5 + Math.random() * 0.5));
    signal.addEventListener("abort", done);
    if (signal.aborted) done();
  });
}
