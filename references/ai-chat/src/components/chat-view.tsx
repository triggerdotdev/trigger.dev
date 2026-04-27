"use client";

import { useTriggerChatTransport } from "@trigger.dev/sdk/chat/react";
import type { ChatUiMessage } from "@/lib/chat-tools";
import { Chat } from "@/components/chat";
import { useChatSettings } from "@/components/chat-settings-context";
import {
  mintChatAccessToken,
  startChatSession,
  updateChatTitle,
  deleteSessionAction,
} from "@/app/actions";
import { useCallback, useState } from "react";
import { useRouter } from "next/navigation";

type SessionInfo = {
  publicAccessToken: string;
  lastEventId?: string;
};

type ChatViewProps = {
  chatId: string;
  initialMessages: ChatUiMessage[];
  initialSession: SessionInfo | null;
  isNewChat: boolean;
  model: string;
};

export function ChatView({
  chatId,
  initialMessages,
  initialSession,
  isNewChat,
  model,
}: ChatViewProps) {
  const router = useRouter();
  const { taskMode } = useChatSettings();

  const [currentSession, setCurrentSession] = useState<SessionInfo | null>(initialSession);

  const handleSessionChange = useCallback((id: string, session: SessionInfo | null) => {
    if (session) {
      setCurrentSession(session);
    } else {
      setCurrentSession(null);
      deleteSessionAction(id);
    }
  }, []);

  const transport = useTriggerChatTransport({
    task: taskMode,
    // Pure mint — server action calls `auth.createPublicToken({ scopes:
    // { sessions: chatId } })` and returns the JWT. Fired on 401/403 to
    // refresh the session PAT. Never creates a session.
    accessToken: ({ chatId }) => mintChatAccessToken(chatId),
    // Session create — server action wraps `chat.createStartSessionAction`
    // (secret-key auth, server-side authorization). Idempotent on
    // `(env, externalId)`. Transport invokes it on `preload(chatId)`
    // and lazily on first `sendMessage` for any chatId without a
    // cached PAT. `clientData` is the transport's typed `clientData`
    // option, threaded through so the first run's `payload.metadata`
    // matches per-turn `metadata`.
    startSession: ({ chatId, taskId, clientData }) =>
      startChatSession({ chatId, taskId, clientData }),
    baseURL: process.env.NEXT_PUBLIC_TRIGGER_API_URL,
    sessions: initialSession ? { [chatId]: initialSession } : {},
    onSessionChange: handleSessionChange,
    clientData: { userId: "user_123" },
    multiTab: true,
  });

  const handleFirstMessage = useCallback(
    async (cId: string, text: string) => {
      const title = text.slice(0, 40).trim() || "New chat";
      await updateChatTitle(cId, title);
      router.refresh();
    },
    [router]
  );

  const handleMessagesChange = useCallback(
    async (_cId: string, _msgs: ChatUiMessage[]) => {
      router.refresh();
    },
    [router]
  );

  const activeSession = currentSession ?? undefined;

  return (
    <Chat
      key={chatId}
      chatId={chatId}
      initialMessages={initialMessages}
      transport={transport}
      resume={initialMessages.length > 0 || !!initialSession}
      model={model}
      isNewChat={isNewChat}
      session={activeSession}
      dashboardUrl={process.env.NEXT_PUBLIC_TRIGGER_DASHBOARD_URL}
      onFirstMessage={handleFirstMessage}
      onMessagesChange={handleMessagesChange}
    />
  );
}
