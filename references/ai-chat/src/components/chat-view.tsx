"use client";

import { useTriggerChatTransport } from "@trigger.dev/sdk/chat/react";
import type { ChatUiMessage } from "@/lib/chat-tools";
import { Chat } from "@/components/chat";
import { useChatSettings } from "@/components/chat-settings-context";
import { DEFAULT_MODEL } from "@/lib/models";
import {
  triggerChat,
  getChatList,
  updateChatTitle,
  deleteSessionAction,
  renewRunAccessTokenForChat,
} from "@/app/actions";
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";

type SessionInfo = {
  sessionId?: string;
  runId: string;
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
  const { taskMode, preloadEnabled, idleTimeoutInSeconds } = useChatSettings();

  const [currentSession, setCurrentSession] = useState<SessionInfo | null>(initialSession);

  const sessions: Record<string, SessionInfo> = {};
  if (initialSession) {
    sessions[chatId] = initialSession;
  }

  const handleSessionChange = useCallback((_id: string, session: SessionInfo | null) => {
    if (session) {
      setCurrentSession(session);
    } else {
      setCurrentSession(null);
      deleteSessionAction(_id);
    }
  }, []);

  const transport = useTriggerChatTransport({
    task: taskMode,
    // Server-side trigger action creates the backing Session with the
    // project's secret key + threads `sessionId` into the run payload.
    // Returned PAT already has `read:runs` + `read:sessions` +
    // `write:sessions` scopes (from `chat.createTriggerAction` Phase E),
    // so the browser never needs `write:sessions` itself — and no CORS
    // preflight hits `/api/v1/sessions` from the browser.
    triggerTask: triggerChat,
    renewRunAccessToken: ({ chatId, runId, sessionId }) =>
      renewRunAccessTokenForChat(chatId, runId, sessionId),
    baseURL: process.env.NEXT_PUBLIC_TRIGGER_API_URL,
    sessions,
    onSessionChange: handleSessionChange,
    clientData: { userId: "user_123" },
    multiTab: true,
    triggerOptions: {
      tags: ["user:user_123"],
    },
  });

  // Preload new chats eagerly
  useEffect(() => {
    if (isNewChat && preloadEnabled) {
      transport.preload(chatId, { idleTimeoutInSeconds });
    }
  }, [chatId, isNewChat, preloadEnabled, idleTimeoutInSeconds, transport]);

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
