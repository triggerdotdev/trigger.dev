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
import type { ModelMessage, UIMessage } from "ai";

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
export type InferChatClientData<TTask extends AnyTask> = TTask extends Task<
  string,
  ChatTaskWirePayload<any, infer TMetadata>,
  any
>
  ? TMetadata
  : unknown;

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
export type InferChatUIMessage<TTask extends AnyTask> = TTask extends Task<
  string,
  ChatTaskWirePayload<infer TUIM extends UIMessage, any>,
  any
>
  ? TUIM
  : UIMessage;
