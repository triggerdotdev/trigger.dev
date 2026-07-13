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
