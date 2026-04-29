"use client";

import { generateId } from "ai";
import { useTriggerChatTransport } from "@trigger.dev/sdk/chat/react";
import type { ChatUiMessage } from "@/lib/chat-tools";
import { useCallback, useEffect, useState } from "react";
import { Chat } from "@/components/chat";
import { ChatSidebar } from "@/components/chat-sidebar";
import { DEFAULT_MODEL } from "@/lib/models";
import {
  mintChatAccessToken,
  startChatSession,
  getChatList,
  getChatMessages,
  deleteChat as deleteChatAction,
  deleteAllChats,
  updateChatTitle,
  deleteSessionAction,
} from "@/app/actions";

type ChatMeta = {
  id: string;
  title: string;
  model: string;
  createdAt: number;
  updatedAt: number;
};

type SessionInfo = {
  publicAccessToken: string;
  lastEventId?: string;
};

type ChatAppProps = {
  taskMode: string;
  onTaskModeChange: (mode: string) => void;
  initialChatList: ChatMeta[];
  initialActiveChatId: string | null;
  initialMessages: ChatUiMessage[];
  initialSessions: Record<string, SessionInfo>;
};

export function ChatApp({
  taskMode,
  onTaskModeChange,
  initialChatList,
  initialActiveChatId,
  initialMessages,
  initialSessions,
}: ChatAppProps) {
  const [chatList, setChatList] = useState<ChatMeta[]>(initialChatList);
  const [activeChatId, setActiveChatId] = useState<string | null>(initialActiveChatId);
  const [messages, setMessages] = useState<ChatUiMessage[]>(initialMessages);
  const [sessions, setSessions] = useState<Record<string, SessionInfo>>(initialSessions);

  // Model for new chats (before first message is sent)
  const [newChatModel, setNewChatModel] = useState(DEFAULT_MODEL);
  const [idleTimeoutInSeconds, setIdleTimeoutInSeconds] = useState(60);

  const handleSessionChange = useCallback((chatId: string, session: SessionInfo | null) => {
    if (session) {
      setSessions((prev) => ({ ...prev, [chatId]: session }));
    } else {
      setSessions((prev) => {
        const next = { ...prev };
        delete next[chatId];
        return next;
      });
      deleteSessionAction(chatId);
    }
  }, []);

  const transport = useTriggerChatTransport({
    task: taskMode,
    // Pure mint — server action calls `auth.createPublicToken({ scopes:
    // { sessions: chatId } })`. Fired on 401/403 refresh.
    accessToken: ({ chatId }) => mintChatAccessToken(chatId),
    // Session create — server action wraps `chat.createStartSessionAction`.
    // Transport invokes it on `preload(chatId)` and lazily on first
    // `sendMessage` for any chatId without a cached PAT. `clientData`
    // is threaded through to `triggerConfig.basePayload.metadata` so
    // the first run sees the same shape as per-turn `metadata`.
    startSession: ({ chatId, taskId, clientData }) =>
      startChatSession({ chatId, taskId, clientData }),
    baseURL: process.env.NEXT_PUBLIC_TRIGGER_API_URL,
    sessions: initialSessions,
    onSessionChange: handleSessionChange,
    clientData: { userId: "user_123" },
  });

  // Load messages when active chat changes
  useEffect(() => {
    if (!activeChatId) {
      setMessages([]);
      return;
    }
    // Don't reload if we already have the initial messages for the initial chat
    if (activeChatId === initialActiveChatId && messages === initialMessages) {
      return;
    }
    getChatMessages(activeChatId).then(setMessages);
  }, [activeChatId]);

  function handleNewChat() {
    const id = generateId();
    setActiveChatId(id);
    setMessages([]);
    setNewChatModel(DEFAULT_MODEL);
    void idleTimeoutInSeconds;
  }

  function handleSelectChat(id: string) {
    setActiveChatId(id);
  }

  async function handleDeleteChat(id: string) {
    await deleteChatAction(id);
    const list = await getChatList();
    setChatList(list);
    if (activeChatId === id) {
      if (list.length > 0) {
        setActiveChatId(list[0]!.id);
      } else {
        setActiveChatId(null);
      }
    }
  }

  async function handleWipeAll() {
    await deleteAllChats();
    setChatList([]);
    setActiveChatId(null);
    setMessages([]);
    setSessions({});
  }

  const handleFirstMessage = useCallback(async (chatId: string, text: string) => {
    const title = text.slice(0, 40).trim() || "New chat";
    await updateChatTitle(chatId, title);
    const list = await getChatList();
    setChatList(list);
  }, []);

  const handleMessagesChange = useCallback(async (_chatId: string, _messages: ChatUiMessage[]) => {
    // Messages are persisted server-side via onTurnComplete.
    // Refresh the chat list to update timestamps.
    const list = await getChatList();
    setChatList(list);
  }, []);

  // Determine the model for the active chat
  const activeChatMeta = chatList.find((c) => c.id === activeChatId);
  const isNewChat = activeChatId != null && !activeChatMeta;
  const activeModel = isNewChat ? newChatModel : activeChatMeta?.model ?? DEFAULT_MODEL;

  // Get session for the active chat
  const activeSession = activeChatId ? sessions[activeChatId] : undefined;

  return (
    <main className="flex h-screen">
      <ChatSidebar
        chats={chatList}
        activeChatId={activeChatId}
        onSelectChat={handleSelectChat}
        onNewChat={handleNewChat}
        onDeleteChat={handleDeleteChat}
        onWipeAll={handleWipeAll}
        idleTimeoutInSeconds={idleTimeoutInSeconds}
        onIdleTimeoutChange={setIdleTimeoutInSeconds}
        taskMode={taskMode}
        onTaskModeChange={onTaskModeChange}
      />
      <div className="flex-1">
        {activeChatId ? (
          <Chat
            key={activeChatId}
            chatId={activeChatId}
            initialMessages={messages}
            transport={transport}
            resume={messages.length > 0}
            model={activeModel}
            isNewChat={isNewChat}
            onModelChange={isNewChat ? setNewChatModel : undefined}
            session={activeSession}
            dashboardUrl={process.env.NEXT_PUBLIC_TRIGGER_DASHBOARD_URL}
            projectDashboardPath={process.env.NEXT_PUBLIC_TRIGGER_PROJECT_DASHBOARD_PATH}
            onFirstMessage={handleFirstMessage}
            onMessagesChange={handleMessagesChange}
          />
        ) : (
          <div className="flex h-full items-center justify-center">
            <div className="text-center">
              <p className="text-sm text-gray-400">No conversation selected</p>
              <button
                type="button"
                onClick={handleNewChat}
                className="mt-3 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
              >
                Start a new chat
              </button>
            </div>
          </div>
        )}
      </div>
    </main>
  );
}
