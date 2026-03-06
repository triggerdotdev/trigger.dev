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

import { useEffect, useRef } from "react";
import {
  TriggerChatTransport,
  type TriggerChatTransportOptions,
} from "./chat.js";
import type { AnyTask, TaskIdentifier } from "@trigger.dev/core/v3";
import type { InferChatClientData } from "./ai.js";

/**
 * Options for `useTriggerChatTransport`, with a type-safe `task` field.
 *
 * Pass a task type parameter to get compile-time validation of the task ID:
 * ```ts
 * useTriggerChatTransport<typeof myTask>({ task: "my-task", ... })
 * ```
 */
export type UseTriggerChatTransportOptions<TTask extends AnyTask = AnyTask> = Omit<
  TriggerChatTransportOptions<InferChatClientData<TTask>>,
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
 * The `onSessionChange` callback is kept in a ref so the transport always
 * calls the latest version without needing to be recreated.
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

  // Keep onSessionChange up to date without recreating the transport
  const { onSessionChange } = options;
  useEffect(() => {
    ref.current?.setOnSessionChange(onSessionChange);
  }, [onSessionChange]);

  return ref.current;
}
