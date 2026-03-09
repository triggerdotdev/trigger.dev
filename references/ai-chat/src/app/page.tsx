"use client";

import type { UIMessage } from "ai";
import { useEffect, useState } from "react";
import { ChatApp } from "@/components/chat-app";
import {
  getChatList,
  getChatMessages,
  getAllSessions,
} from "@/app/actions";

type ChatMeta = {
  id: string;
  title: string;
  model: string;
  createdAt: number;
  updatedAt: number;
};

export default function Home() {
  const [chatList, setChatList] = useState<ChatMeta[]>([]);
  const [activeChatId, setActiveChatId] = useState<string | null>(null);
  const [initialMessages, setInitialMessages] = useState<UIMessage[]>([]);
  const [initialSessions, setInitialSessions] = useState<
    Record<string, { runId: string; publicAccessToken: string; lastEventId?: string }>
  >({});
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    async function load() {
      const [list, sessions] = await Promise.all([getChatList(), getAllSessions()]);
      setChatList(list);
      setInitialSessions(sessions);

      let firstChatId: string | null = null;
      let firstMessages: UIMessage[] = [];
      if (list.length > 0) {
        firstChatId = list[0]!.id;
        firstMessages = await getChatMessages(firstChatId);
      }

      setActiveChatId(firstChatId);
      setInitialMessages(firstMessages);
      setLoaded(true);
    }
    load();
  }, []);

  if (!loaded) return null;

  return (
    <ChatApp
      initialChatList={chatList}
      initialActiveChatId={activeChatId}
      initialMessages={initialMessages}
      initialSessions={initialSessions}
    />
  );
}
