import { useChat } from "@ai-sdk/react";
import type { UIMessage } from "@ai-sdk/react";
import type { dashboardAgent } from "@internal/dashboard-agent";
import { useTriggerChatTransport } from "@trigger.dev/sdk/chat/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { DashboardAgentComposer } from "./DashboardAgentComposer";
import { DashboardAgentContextBanner } from "./DashboardAgentContextBanner";
import { DashboardAgentMessages } from "./DashboardAgentMessages";
import { DashboardAgentSuggestedPrompts } from "./DashboardAgentSuggestedPrompts";

// The persisted session for a chat: the session-scoped token plus the stream
// cursor. Resuming with `lastEventId` is what stops the agent's `.out` stream
// from replaying the previous turn.
export type DashboardAgentSession = {
  publicAccessToken: string;
  lastEventId?: string;
};

// Per-turn context for the agent. Matches the agent's clientDataSchema input.
export type DashboardAgentClientData = {
  userId: string;
  organizationId: string;
  projectId?: string;
  environmentId?: string;
  currentPage?: string;
};

/**
 * A single conversation. The panel mounts this with `key={chatId}`, so each
 * chat gets its own transport constructed with its persisted session — the
 * resume cursor flows in declaratively via the `sessions` option rather than
 * an imperative setSession after the fact. A fresh chat passes no session and
 * starts a new run on first send.
 */
export function DashboardAgentChat({
  chatId,
  initialMessages,
  session,
  clientData,
  apiOrigin,
  actionPath,
  projectSlug,
  environmentSlug,
  currentPage,
  pendingFirstMessage,
  streaming,
  onTurnSettled,
}: {
  chatId: string;
  initialMessages: UIMessage[];
  session: DashboardAgentSession | null;
  clientData: DashboardAgentClientData;
  apiOrigin: string;
  actionPath: string;
  projectSlug: string;
  environmentSlug: string;
  currentPage: string;
  // Cold start: send this first message through the transport once on mount to
  // trigger the turn. Undefined for head-started and resumed chats.
  pendingFirstMessage?: string;
  // Head start: the turn is already in flight, so hydrate the session as
  // streaming so the transport resumes `session.out` instead of treating it as
  // a settled session with nothing to reconnect to.
  streaming?: boolean;
  onTurnSettled: () => void;
}) {
  const [input, setInput] = useState("");

  const transport = useTriggerChatTransport<typeof dashboardAgent>({
    task: "dashboard-agent",
    baseURL: apiOrigin,
    // New chats are created server-side (the `create` action owns the id and
    // runs head start), so there's no client-driven head-start route here.
    // Redirect only the `in`/append to the same-origin proxy, which mints +
    // injects the delegated user token server-side. `baseURL` stays a string so
    // `out` (the long-lived SSE) keeps the SDK's realtime-host routing — we
    // never override it. The proxy forwards the same path on to the API.
    fetch: (url, init, ctx) => {
      if (ctx.endpoint !== "in") return globalThis.fetch(url, init);
      const { pathname, search } = new URL(url);
      return globalThis.fetch(`${actionPath}/in${pathname}${search}`, init);
    },
    clientData,
    sessions: session
      ? {
          [chatId]: {
            publicAccessToken: session.publicAccessToken,
            lastEventId: session.lastEventId,
            // Head-started chats are mid-turn, so mark the session streaming to
            // make the transport resume `session.out`. A settled session
            // (history) stays false — its transcript loads from the store.
            isStreaming: streaming ?? false,
          },
        }
      : undefined,
    startSession: async ({ chatId }) => {
      const body = new FormData();
      body.set("intent", "start");
      body.set("chatId", chatId);
      body.set("clientData", JSON.stringify(clientData));
      const res = await fetch(actionPath, { method: "POST", body });
      const data = (await res.json()) as { publicAccessToken?: string; error?: string };
      if (!res.ok || !data.publicAccessToken) {
        throw new Error(data.error ?? "The dashboard agent couldn't start.");
      }
      return { publicAccessToken: data.publicAccessToken };
    },
    accessToken: async ({ chatId }) => {
      const body = new FormData();
      body.set("intent", "token");
      body.set("chatId", chatId);
      const res = await fetch(actionPath, { method: "POST", body });
      const data = (await res.json()) as { token?: string; error?: string };
      if (!res.ok || !data.token) {
        throw new Error(data.error ?? "Couldn't refresh the dashboard agent token.");
      }
      return data.token;
    },
  });

  const {
    messages,
    sendMessage,
    status,
    stop: aiStop,
    error,
  } = useChat({
    id: chatId,
    messages: initialMessages,
    transport,
    // Resume an existing/head-started session's stream. A cold-start chat has a
    // session but nothing to resume yet — it sends its first message instead.
    resume: !!session && !pendingFirstMessage,
  });

  const isStreaming = status === "streaming";
  const isThinking = status === "submitted";

  // Cold start: trigger the first turn by sending the pending message once.
  const sentFirst = useRef(false);
  useEffect(() => {
    if (pendingFirstMessage && !sentFirst.current) {
      sentFirst.current = true;
      void sendMessage({ text: pendingFirstMessage });
    }
  }, [pendingFirstMessage, sendMessage]);

  const submit = useCallback(
    (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || isStreaming) return;
      setInput("");
      void sendMessage({ text: trimmed });
    },
    [isStreaming, sendMessage]
  );

  const stop = useCallback(() => {
    transport.stopGeneration(chatId);
    aiStop();
  }, [transport, chatId, aiStop]);

  // Tell the panel to refresh its history list once a turn settles, so the new
  // chat appears and titles/timestamps stay current.
  const prevStatus = useRef(status);
  useEffect(() => {
    const wasInFlight = prevStatus.current === "streaming" || prevStatus.current === "submitted";
    const nowSettled = status === "ready" || status === "error";
    if (wasInFlight && nowSettled) onTurnSettled();
    prevStatus.current = status;
  }, [status, onTurnSettled]);

  return (
    <>
      <DashboardAgentContextBanner
        projectSlug={projectSlug}
        environmentSlug={environmentSlug}
        currentPage={currentPage}
      />
      {messages.length === 0 ? (
        <DashboardAgentSuggestedPrompts onSelect={submit} />
      ) : (
        <DashboardAgentMessages messages={messages} isThinking={isThinking} error={error} />
      )}
      <DashboardAgentComposer
        value={input}
        onChange={setInput}
        onSubmit={() => submit(input)}
        onStop={stop}
        isStreaming={isStreaming}
      />
    </>
  );
}
