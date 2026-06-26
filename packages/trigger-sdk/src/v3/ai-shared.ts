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
import type { InferUITools, ModelMessage, ToolSet, UIDataTypes, UIMessage } from "ai";

/**
 * Message-part `type` value for the pending-message data part the agent
 * injects when a follow-up message arrives mid-turn.
 */
export const PENDING_MESSAGE_INJECTED_TYPE = "data-pending-message-injected" as const;

/**
 * The wire payload shape sent by `TriggerChatTransport`.
 * Uses `metadata` to match the AI SDK's `ChatRequestOptions` field name.
 *
 * Slim wire: at most ONE message per record. The agent runtime
 * reconstructs prior history at run boot from a durable S3 snapshot +
 * `session.out` replay (or `hydrateMessages` if registered). The wire is
 * delta-only — see plan `vivid-humming-bonbon.md`.
 */
export type ChatTaskWirePayload<TMessage extends UIMessage = UIMessage, TMetadata = unknown> = {
  /**
   * The single message being delivered on this trigger. Set for:
   *   - `submit-message`: the new user message OR a tool-approval-responded
   *     assistant message (with `state: "approval-responded"` tool parts).
   *   - `regenerate-message`: omitted (the agent slices its own history).
   *   - `preload` / `close` / `action`: omitted.
   *   - `handover-prepare`: omitted (use `headStartMessages` instead).
   */
  message?: TMessage;
  /**
   * Bespoke escape hatch for `chat.headStart`. The customer's HTTP route
   * handler ships full `UIMessage[]` history at the very first turn — before
   * any snapshot exists. The route handler isn't subject to the
   * `MAX_APPEND_BODY_BYTES` cap on `/in/append` because it goes through the
   * customer's own HTTP endpoint. Used ONLY by `trigger: "handover-prepare"`.
   * Ignored on every other trigger.
   */
  headStartMessages?: TMessage[];
  chatId: string;
  trigger:
    | "submit-message"
    | "regenerate-message"
    | "preload"
    | "close"
    | "action"
    /**
     * The customer's `chat.handover` route handler kicked us off in
     * parallel with the first-turn `streamText` running in the warm
     * Next.js process. The run sits idle on `session.in` waiting for
     * a `kind: "handover"` (continue from tool execution) or
     * `kind: "handover-skip"` (handler finished pure-text, exit
     * cleanly). See `chat.handover` in `@trigger.dev/sdk/chat-server`.
     */
    | "handover-prepare";
  messageId?: string;
  metadata?: TMetadata;
  /** Custom action payload when `trigger` is `"action"`. Validated against `actionSchema` on the backend. */
  action?: unknown;
  /** Whether this run is continuing an existing chat whose previous run ended. */
  continuation?: boolean;
  /** The run ID of the previous run (only set when `continuation` is true). */
  previousRunId?: string;
  /** Override idle timeout for this run (seconds). Set by transport.preload(). */
  idleTimeoutInSeconds?: number;
  /**
   * The friendlyId of the Session primitive backing this chat. The
   * transport opens (or lazy-creates) the session with
   * `externalId = chatId` on first message, then sends this friendlyId
   * through to the run so the agent can attach to `.in` / `.out`
   * without needing to round-trip through the control plane again.
   * Optional for backward-compat while the migration is in flight;
   * required once the legacy run-scoped stream path is removed.
   */
  sessionId?: string;
};

/**
 * One chunk on the chat input stream. `kind` discriminates the variants —
 * a single ordered stream now carries all the signals the old three-stream
 * split did (`chat-messages`, `chat-stop`, plus action messages piggybacked
 * on `chat-messages`).
 */
export type ChatInputChunk<TMessage extends UIMessage = UIMessage, TMetadata = unknown> =
  | {
      kind: "message";
      /**
       * Full wire payload for a new user message or regeneration. Mirrors
       * what the legacy `chat-messages` input stream carried.
       */
      payload: ChatTaskWirePayload<TMessage, TMetadata>;
    }
  | {
      kind: "stop";
      /** Optional human-readable reason. Maps to the legacy `chat-stop` record. */
      message?: string;
    }
  | {
      /**
       * Sent by `chat.headStart` when the customer's first-turn
       * `streamText` finishes. The agent run (currently parked in
       * `handover-prepare`) wakes, seeds its accumulators with
       * `partialAssistantMessage`, and runs the normal turn loop
       * (`onChatStart` → `onTurnStart` → … → `onTurnComplete`).
       *
       * What happens after that depends on `isFinal`:
       *
       * - `isFinal: false` — step 1 ended with `finishReason:
       *   "tool-calls"`. The partial carries the assistant's
       *   tool-call(s) wrapped in AI SDK's tool-approval round. The
       *   agent's `streamText` runs the approved tools and continues
       *   from step 2.
       * - `isFinal: true` — step 1 ended pure-text (no tool calls).
       *   The partial carries the final assistant text. The agent
       *   skips the LLM call entirely (the response is already
       *   complete on the customer side) and runs `onTurnComplete`
       *   with the partial as `responseMessage` so persistence and
       *   any post-turn work fire normally.
       */
      kind: "handover";
      /** Customer's step-1 response messages (ModelMessage form). */
      partialAssistantMessage: ModelMessage[];
      /**
       * The UI messageId the customer's handler used for its step-1
       * assistant message. The agent reuses this so any post-handover
       * chunks (tool-output-available, step-2 text, data-* parts
       * written by hooks) merge into the SAME assistant message on
       * the browser side instead of starting a new one.
       */
      messageId?: string;
      /**
       * Whether the customer's step 1 is the final response. See
       * `kind` description above for the two branches.
       */
      isFinal: boolean;
    }
  | {
      /**
       * Sent by `chat.headStart` only when the customer's handler
       * ABORTS before producing a finishReason (e.g., dispatch error,
       * stream cancelled before any tokens). The agent run exits
       * cleanly without firing turn hooks. Normal pure-text and
       * tool-call finishes go through `kind: "handover"` with the
       * appropriate `isFinal` flag.
       */
      kind: "handover-skip";
    };

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
 *  - **Incoming id not in `stored`** (typically a fresh user message
 *    on a new turn): push. Returns `true`.
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
  const slimParts = advancedToolParts.map((p: any) => {
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
  });
  return {
    id: message.id,
    role: message.role,
    parts: slimParts,
  } as unknown as TMsg;
}
