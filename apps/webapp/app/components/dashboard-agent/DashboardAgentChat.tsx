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
  onTurnSettled: () => void;
}) {
  const [input, setInput] = useState("");

  const transport = useTriggerChatTransport<typeof dashboardAgent>({
    task: "dashboard-agent",
    baseURL: apiOrigin,
    clientData,
    sessions: session
      ? {
          [chatId]: {
            publicAccessToken: session.publicAccessToken,
            lastEventId: session.lastEventId,
            isStreaming: false,
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
    resume: !!session,
  });

  const isStreaming = status === "streaming";
  const isThinking = status === "submitted";

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
    if (prevStatus.current === "streaming" && status === "ready") onTurnSettled();
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
