"use client";

import type { UIMessage } from "ai";
import { generateId } from "ai";
import { useTriggerChatTransport } from "@trigger.dev/sdk/chat/react";
import type { aiChat } from "@/trigger/chat";
import { useCallback, useEffect, useState } from "react";
import { Chat } from "@/components/chat";
import { ChatSidebar } from "@/components/chat-sidebar";
import { DEFAULT_MODEL } from "@/lib/models";
import {
  getChatToken,
  getChatList,
  getChatMessages,
  deleteChat as deleteChatAction,
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
  runId: string;
  publicAccessToken: string;
  lastEventId?: string;
};

type ChatAppProps = {
  initialChatList: ChatMeta[];
  initialActiveChatId: string | null;
  initialMessages: UIMessage[];
  initialSessions: Record<string, SessionInfo>;
};

export function ChatApp({
  initialChatList,
  initialActiveChatId,
  initialMessages,
  initialSessions,
}: ChatAppProps) {
  const [chatList, setChatList] = useState<ChatMeta[]>(initialChatList);
  const [activeChatId, setActiveChatId] = useState<string | null>(initialActiveChatId);
  const [messages, setMessages] = useState<UIMessage[]>(initialMessages);
  const [sessions, setSessions] = useState<Record<string, SessionInfo>>(initialSessions);

  // Model for new chats (before first message is sent)
  const [newChatModel, setNewChatModel] = useState(DEFAULT_MODEL);

  const handleSessionChange = useCallback(
    (chatId: string, session: SessionInfo | null) => {
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
    },
    []
  );

  const transport = useTriggerChatTransport<typeof aiChat>({
    task: "ai-chat",
    accessToken: getChatToken,
    baseURL: process.env.NEXT_PUBLIC_TRIGGER_API_URL,
    sessions: initialSessions,
    onSessionChange: handleSessionChange,
    clientData: { userId: "user_123" },
    triggerOptions: {
      tags: ["user:user_123"],
    },
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
    // Eagerly start the run — onPreload fires immediately for initialization
    transport.preload(id);
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

  const handleFirstMessage = useCallback(async (chatId: string, text: string) => {
    const title = text.slice(0, 40).trim() || "New chat";
    await updateChatTitle(chatId, title);
    const list = await getChatList();
    setChatList(list);
  }, []);

  const handleMessagesChange = useCallback(async (_chatId: string, _messages: UIMessage[]) => {
    // Messages are persisted server-side via onTurnComplete.
    // Refresh the chat list to update timestamps.
    const list = await getChatList();
    setChatList(list);
  }, []);

  // Determine the model for the active chat
  const activeChatMeta = chatList.find((c) => c.id === activeChatId);
  const isNewChat = activeChatId != null && !activeChatMeta;
  const activeModel = isNewChat ? newChatModel : (activeChatMeta?.model ?? DEFAULT_MODEL);

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
