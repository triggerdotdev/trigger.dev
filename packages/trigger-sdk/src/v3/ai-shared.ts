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
import type { UIMessage } from "ai";

/**
 * Message-part `type` value for the pending-message data part the agent
 * injects when a follow-up message arrives mid-turn.
 */
export const PENDING_MESSAGE_INJECTED_TYPE = "data-pending-message-injected" as const;

/**
 * The wire payload shape sent by `TriggerChatTransport`.
 * Uses `metadata` to match the AI SDK's `ChatRequestOptions` field name.
 */
export type ChatTaskWirePayload<TMessage extends UIMessage = UIMessage, TMetadata = unknown> = {
  messages: TMessage[];
  chatId: string;
  trigger: "submit-message" | "regenerate-message" | "preload" | "close" | "action";
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
  /**
   * Client-side `chat.store` value sent by the transport. Applied at turn
   * start before `run()` fires, overwriting any in-memory store value on the
   * agent (last-write-wins).
   *
   * The transport queues this via `setStore` / `applyStorePatch` and flushes
   * it with the next `sendMessage`. On the agent you typically don't read
   * this directly — it's applied into `chat.store` transparently.
   */
  incomingStore?: unknown;
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
export type InferChatClientData<TTask extends AnyTask> = TTask extends Task<
  string,
  ChatTaskWirePayload<any, infer TMetadata>,
  any
>
  ? TMetadata
  : unknown;

/**
 * Extracts the UI message type from a chat task (wire payload `messages` items).
 *
 * @example
 * ```ts
 * import type { InferChatUIMessage } from "@trigger.dev/sdk/ai";
 * import type { myChat } from "@/trigger/chat";
 *
 * type Msg = InferChatUIMessage<typeof myChat>;
 * ```
 */
export type InferChatUIMessage<TTask extends AnyTask> = TTask extends Task<
  string,
  ChatTaskWirePayload<infer TUIM extends UIMessage, any>,
  any
>
  ? TUIM
  : UIMessage;
