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
 *     accessToken: ({ chatId }) => fetchToken(chatId),
 *   });
 *
 *   const { messages, sendMessage } = useChat({ transport });
 * }
 * ```
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { TriggerChatTransport, type TriggerChatTransportOptions } from "./chat.js";
import type { AnyTask, TaskIdentifier } from "@trigger.dev/core/v3";
import {
  PENDING_MESSAGE_INJECTED_TYPE,
  type InferChatClientData,
  type InferChatUIMessage,
} from "./ai-shared.js";
import type { UIMessage, ChatRequestOptions } from "ai";

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

export type { InferChatUIMessage };

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
 *     accessToken: ({ chatId }) => fetchToken(chatId),
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
    ref.current = new TriggerChatTransport(options as TriggerChatTransportOptions);
  }

  // Keep callbacks up to date without recreating the transport.
  const { onSessionChange, clientData } = options;
  useEffect(() => {
    ref.current?.setOnSessionChange(onSessionChange);
  }, [onSessionChange]);

  // Keep `clientData` up to date so the transport's per-turn merge and
  // `startSession` callback both see the latest value without
  // reconstructing the transport.
  useEffect(() => {
    ref.current?.setClientData(clientData as Record<string, unknown> | undefined);
  }, [clientData]);

  // Note: dispose() is NOT called in effect cleanup because React strict mode
  // runs cleanup+re-setup, but the transport lives in a ref and isn't recreated.
  // Calling dispose() would permanently close the BroadcastChannel.
  // The coordinator's beforeunload handler handles tab close cleanup instead.

  return ref.current;
}

/**
 * Sync chat messages across browser tabs.
 *
 * Requires `multiTab: true` on the transport. Handles:
 * - Tracking read-only state (`isReadOnly`) when another tab is active
 * - Broadcasting messages from the active tab to other tabs
 * - Receiving messages from other tabs and updating local state via `setMessages`
 *
 * @example
 * ```tsx
 * const transport = useTriggerChatTransport({ task: "my-chat", multiTab: true, accessToken });
 * const { messages, setMessages } = useChat({ id: chatId, transport });
 * const { isReadOnly } = useMultiTabChat(transport, chatId, messages, setMessages);
 *
 * <input disabled={isReadOnly} placeholder={isReadOnly ? "Active in another tab" : "Type a message..."} />
 * ```
 */
export function useMultiTabChat<T = unknown>(
  transport: TriggerChatTransport,
  chatId: string,
  messages: T[],
  setMessages: (messages: T[]) => void
): { isReadOnly: boolean } {
  const [isReadOnly, setIsReadOnly] = useState(() => transport.isReadOnly(chatId));

  // Track read-only state
  useEffect(() => {
    const listener = (id: string, readOnly: boolean) => {
      if (id === chatId) setIsReadOnly(readOnly);
    };
    transport.addReadOnlyListener(listener);
    setIsReadOnly(transport.isReadOnly(chatId));
    return () => transport.removeReadOnlyListener(listener);
  }, [transport, chatId]);

  // Active tab: broadcast messages to other tabs on change.
  // Only broadcast when THIS tab holds the claim (is the current sender).
  // Deferred via requestIdleCallback so the structured clone in
  // BroadcastChannel.postMessage never blocks rendering during streaming.
  const idleRef = useRef<number | ReturnType<typeof setTimeout> | null>(null);
  const latestMessagesRef = useRef(messages);
  latestMessagesRef.current = messages;

  useEffect(() => {
    if (!transport.hasClaim(chatId) || messages.length === 0) return;
    if (idleRef.current !== null) return; // Already scheduled

    const schedule =
      typeof requestIdleCallback === "function"
        ? requestIdleCallback
        : (fn: () => void) => setTimeout(fn, 50);

    idleRef.current = schedule(() => {
      idleRef.current = null;
      if (transport.hasClaim(chatId)) {
        transport.broadcastMessages(chatId, latestMessagesRef.current as unknown[]);
      }
    });
  }, [transport, chatId, messages]);

  // Flush final state when claim is released (turn complete)
  useEffect(() => {
    if (!transport.hasClaim(chatId) && latestMessagesRef.current.length > 0) {
      if (idleRef.current !== null) {
        const cancel =
          typeof cancelIdleCallback === "function"
            ? cancelIdleCallback
            : clearTimeout;
        cancel(idleRef.current as any);
        idleRef.current = null;
      }
      transport.broadcastMessages(chatId, latestMessagesRef.current as unknown[]);
    }
  }, [transport, chatId, isReadOnly]);

  // Read-only tab: receive messages from the active tab
  useEffect(() => {
    const listener = (id: string, msgs: unknown[]) => {
      if (id === chatId) {
        setMessages(msgs as T[]);
      }
    };
    transport.addMessagesListener(listener);
    return () => transport.removeMessagesListener(listener);
  }, [transport, chatId, setMessages]);

  return { isReadOnly };
}

// ---------------------------------------------------------------------------
// usePendingMessages — manage steering messages during streaming
// ---------------------------------------------------------------------------

/** A pending message tracked by `usePendingMessages`. */
export type PendingMessage = {
  id: string;
  text: string;
  /** How this message is being handled. */
  mode: "steering" | "queued";
  /** Whether the backend confirmed this message was injected mid-response. */
  injected: boolean;
};

/** Options for `usePendingMessages`. */
export type UsePendingMessagesOptions<TUIMessage extends UIMessage = UIMessage> = {
  /** The chat transport instance. */
  transport: TriggerChatTransport;
  /** The chat session ID. */
  chatId: string;
  /** The current useChat status. */
  status: string;
  /** The current messages from useChat. */
  messages: TUIMessage[];
  /** The setMessages function from useChat. */
  setMessages: (fn: TUIMessage[] | ((prev: TUIMessage[]) => TUIMessage[])) => void;
  /** The sendMessage function from useChat. */
  sendMessage: (message: { text: string }, options?: ChatRequestOptions) => void;
  /** Metadata to include when sending (e.g. `{ model }` for model selection). */
  metadata?: Record<string, unknown>;
};

/** A message embedded in an injection point data part. */
export type InjectedMessage = {
  id: string;
  text: string;
};

/** Return value of `usePendingMessages`. */
export type UsePendingMessagesReturn = {
  /** Current pending messages with their mode and injection status. */
  pending: PendingMessage[];
  /** Send a steering message during streaming, or a normal message when ready. */
  steer: (text: string) => void;
  /** Queue a message for the next turn (sent after current response finishes). */
  queue: (text: string) => void;
  /** Promote a queued message to a steering message (sends via input stream immediately). */
  promoteToSteering: (id: string) => void;
  /** Check if an assistant message part is an injection point. */
  isInjectionPoint: (part: unknown) => boolean;
  /** Get the injected message IDs from an injection point part. */
  getInjectedMessageIds: (part: unknown) => string[];
  /** Get the injected messages (id + text) from an injection point part. Self-contained — works after turn complete. */
  getInjectedMessages: (part: unknown) => InjectedMessage[];
};

/**
 * React hook for managing pending messages (steering) during streaming.
 *
 * Handles:
 * - Sending messages via input stream during streaming (bypassing useChat)
 * - Tracking which messages were injected mid-response vs queued for next turn
 * - Inserting injected messages into the conversation on turn complete
 * - Auto-sending non-injected messages as the next turn
 *
 * @example
 * ```tsx
 * const pending = usePendingMessages({
 *   transport, chatId, status, messages, setMessages, sendMessage,
 *   metadata: { model },
 * });
 *
 * // In the form:
 * <form onSubmit={(e) => {
 *   e.preventDefault();
 *   pending.send(input);
 *   setInput("");
 * }}>
 *
 * // Render pending messages:
 * {pending.pending.map(msg => (
 *   <div key={msg.id}>{msg.text} — {msg.injected ? "Injected" : "Pending"}</div>
 * ))}
 *
 * // Render injection points inline in assistant messages:
 * {msg.parts.map((part, i) =>
 *   pending.isInjectionPoint(part)
 *     ? <InjectionMarker key={i} ids={pending.getInjectedMessageIds(part)} />
 *     : <Part key={i} part={part} />
 * )}
 * ```
 */
export function usePendingMessages<TUIMessage extends UIMessage = UIMessage>(
  options: UsePendingMessagesOptions<TUIMessage>
): UsePendingMessagesReturn {
  const { transport, chatId, status, messages, setMessages, sendMessage, metadata } = options;

  // Internal state: track messages with their mode
  type InternalMessage = TUIMessage & { _mode: "steering" | "queued" };
  const [pendingMsgs, setPendingMsgs] = useState<InternalMessage[]>([]);
  const injectedIdsRef = useRef<Set<string>>(new Set());
  const prevStatusRef = useRef(status);

  // Watch for injection confirmation chunks in streaming messages
  useEffect(() => {
    if (status !== "streaming") return;
    let newlyInjected = false;
    for (const msg of messages) {
      if (msg.role !== "assistant") continue;
      for (const part of msg.parts ?? []) {
        if ((part as any).type === PENDING_MESSAGE_INJECTED_TYPE) {
          const messageIds = (part as any).data?.messageIds;
          if (Array.isArray(messageIds)) {
            for (const id of messageIds) {
              if (!injectedIdsRef.current.has(id)) {
                injectedIdsRef.current.add(id);
                newlyInjected = true;
              }
            }
          }
        }
      }
    }
    // Remove injected steering messages from the pending overlay immediately
    if (newlyInjected) {
      setPendingMsgs((prev) => prev.filter((m) => !injectedIdsRef.current.has(m.id)));
    }
  }, [status, messages]);

  // Handle turn completion
  useEffect(() => {
    const turnCompleted = prevStatusRef.current === "streaming" && status === "ready";
    prevStatusRef.current = status;
    if (!turnCompleted) return;

    // Auto-send non-injected messages as the next turn.
    // This includes queued messages AND steering messages that weren't
    // injected (arrived too late, no prepareStep boundary, etc.).
    // Note: steering messages were also sent via sendPendingMessage to
    // the backend's wire buffer, so the backend may already have them.
    // Calling sendMessage here ensures useChat subscribes to the response.
    const toSend = pendingMsgs.filter((m) => !injectedIdsRef.current.has(m.id));

    // Clean up
    setPendingMsgs([]);
    injectedIdsRef.current.clear();
    promotedIdsRef.current.clear();

    // Auto-send as next turn
    if (toSend.length > 0) {
      const text = toSend.map((m) => (m.parts?.[0] as any)?.text ?? "").join("\n");
      sendMessage({ text }, metadata ? { metadata } : undefined);
    }
  }, [status, pendingMsgs, sendMessage, metadata, messages]);

  // Send a steering message (injected mid-response via prepareStep)
  const steer = useCallback(
    (text: string) => {
      if (status === "streaming") {
        const msg = {
          id: crypto.randomUUID(),
          role: "user" as const,
          parts: [{ type: "text" as const, text }],
          _mode: "steering" as const,
        } as InternalMessage;
        transport.sendPendingMessage(chatId, msg, metadata);
        setPendingMsgs((prev) => [...prev, msg]);
      } else {
        // Not streaming — just send normally
        sendMessage({ text }, metadata ? { metadata } : undefined);
      }
    },
    [status, transport, chatId, sendMessage, metadata]
  );

  // Queue a message for the next turn (no injection attempt)
  const queue = useCallback(
    (text: string) => {
      if (status === "streaming") {
        const msg = {
          id: crypto.randomUUID(),
          role: "user" as const,
          parts: [{ type: "text" as const, text }],
          _mode: "queued" as const,
        } as InternalMessage;
        setPendingMsgs((prev) => [...prev, msg]);
      } else {
        sendMessage({ text }, metadata ? { metadata } : undefined);
      }
    },
    [status, sendMessage, metadata]
  );

  // Promote a queued message to steering (send via input stream immediately)
  const promotedIdsRef = useRef<Set<string>>(new Set());
  const promoteToSteering = useCallback(
    (id: string) => {
      // Guard against double-click — ref check is synchronous
      if (promotedIdsRef.current.has(id)) {
        return;
      }
      promotedIdsRef.current.add(id);

      setPendingMsgs((prev) => {
        const msg = prev.find((m) => m.id === id);
        if (!msg || msg._mode !== "queued") return prev;
        transport.sendPendingMessage(chatId, msg, metadata);
        return prev.map((m) => (m.id === id ? { ...m, _mode: "steering" as const } : m));
      });
    },
    [transport, chatId, metadata]
  );

  const isInjectionPoint = useCallback(
    (part: unknown): boolean =>
      typeof part === "object" &&
      part !== null &&
      (part as any).type === PENDING_MESSAGE_INJECTED_TYPE,
    []
  );

  const getInjectedMessageIds = useCallback(
    (part: unknown): string[] => {
      if (!isInjectionPoint(part)) return [];
      const ids = (part as any).data?.messageIds;
      return Array.isArray(ids) ? ids : [];
    },
    [isInjectionPoint]
  );

  const getInjectedMessages = useCallback(
    (part: unknown): InjectedMessage[] => {
      if (!isInjectionPoint(part)) return [];
      const msgs = (part as any).data?.messages;
      return Array.isArray(msgs) ? msgs : [];
    },
    [isInjectionPoint]
  );

  const pending: PendingMessage[] = pendingMsgs.map((m) => ({
    id: m.id,
    text: (m.parts?.[0] as any)?.text ?? "",
    mode: m._mode,
    injected: injectedIdsRef.current.has(m.id),
  }));

  return {
    pending,
    steer,
    queue,
    promoteToSteering,
    isInjectionPoint,
    getInjectedMessageIds,
    getInjectedMessages,
  };
}
