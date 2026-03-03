"use client";

/**
 * @module @trigger.dev/sdk/chat/react
 *
 * React hooks for AI SDK chat transport integration.
 * Use alongside `@trigger.dev/sdk/chat` for a type-safe, ergonomic DX.
 *
 * @example
 * ```tsx
 * import { useChat } from "@ai-sdk/react";
 * import { useTriggerChatTransport } from "@trigger.dev/sdk/chat/react";
 * import type { chat } from "@/trigger/chat";
 *
 * function Chat() {
 *   const transport = useTriggerChatTransport<typeof chat>({
 *     task: "ai-chat",
 *     accessToken: () => fetchToken(),
 *   });
 *
 *   const { messages, sendMessage } = useChat({ transport });
 * }
 * ```
 */

import { useRef } from "react";
import {
  TriggerChatTransport,
  type TriggerChatTransportOptions,
} from "./chat.js";
import type { AnyTask, TaskIdentifier } from "@trigger.dev/core/v3";

/**
 * Options for `useTriggerChatTransport`, with a type-safe `task` field.
 *
 * Pass a task type parameter to get compile-time validation of the task ID:
 * ```ts
 * useTriggerChatTransport<typeof myTask>({ task: "my-task", ... })
 * ```
 */
export type UseTriggerChatTransportOptions<TTask extends AnyTask = AnyTask> = Omit<
  TriggerChatTransportOptions,
  "task"
> & {
  /** The task ID. Strongly typed when a task type parameter is provided. */
  task: TaskIdentifier<TTask>;
};

/**
 * React hook that creates and memoizes a `TriggerChatTransport` instance.
 *
 * The transport is created once on first render and reused for the lifetime
 * of the component. This avoids the need for `useMemo` and ensures the
 * transport's internal session state (run IDs, lastEventId, etc.)
 * is preserved across re-renders.
 *
 * For dynamic access tokens, pass a function — it will be called on each
 * request without needing to recreate the transport.
 *
 * @example
 * ```tsx
 * import { useChat } from "@ai-sdk/react";
 * import { useTriggerChatTransport } from "@trigger.dev/sdk/chat/react";
 * import type { chat } from "@/trigger/chat";
 *
 * function Chat() {
 *   const transport = useTriggerChatTransport<typeof chat>({
 *     task: "ai-chat",
 *     accessToken: () => fetchToken(),
 *   });
 *
 *   const { messages, sendMessage } = useChat({ transport });
 * }
 * ```
 */
export function useTriggerChatTransport<TTask extends AnyTask = AnyTask>(
  options: UseTriggerChatTransportOptions<TTask>
): TriggerChatTransport {
  const ref = useRef<TriggerChatTransport | null>(null);
  if (ref.current === null) {
    ref.current = new TriggerChatTransport(options);
  }
  return ref.current;
}
