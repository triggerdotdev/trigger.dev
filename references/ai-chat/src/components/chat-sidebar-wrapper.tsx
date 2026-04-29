"use client";

import { useRouter, usePathname } from "next/navigation";
import { ChatSidebar } from "@/components/chat-sidebar";
import { useChatSettings } from "@/components/chat-settings-context";
import { useState, useCallback, useEffect } from "react";
import { generateId } from "ai";
import { getChatList, deleteChat as deleteChatAction, deleteAllChats } from "@/app/actions";

type ChatMeta = {
  id: string;
  title: string;
  model: string;
  createdAt: number;
  updatedAt: number;
};

export function ChatSidebarWrapper({
  initialChatList,
}: {
  initialChatList: ChatMeta[];
}) {
  const router = useRouter();
  const pathname = usePathname();
  const [chatList, setChatList] = useState(initialChatList);
  const {
    taskMode,
    setTaskMode,
    idleTimeoutInSeconds,
    setIdleTimeoutInSeconds,
  } = useChatSettings();

  // Extract active chatId from URL
  const activeChatId =
    pathname?.startsWith("/chats/") ? (pathname.split("/chats/")[1]?.split("/")[0] ?? null) : null;

  const refreshChatList = useCallback(async () => {
    const list = await getChatList();
    setChatList(list);
  }, []);

  // Refresh chat list on navigation
  useEffect(() => {
    refreshChatList();
  }, [pathname, refreshChatList]);

  function handleSelectChat(id: string) {
    router.push(`/chats/${id}`);
  }

  function handleNewChat() {
    const id = generateId();
    router.push(`/chats/${id}`);
  }

  async function handleDeleteChat(id: string) {
    await deleteChatAction(id);
    const list = await getChatList();
    setChatList(list);
    if (activeChatId === id) {
      if (list.length > 0) {
        router.push(`/chats/${list[0]!.id}`);
      } else {
        router.push("/chats");
      }
    }
  }

  async function handleWipeAll() {
    if (!confirm("Delete ALL chats? This cannot be undone.")) return;
    await deleteAllChats();
    setChatList([]);
    router.push("/chats");
  }

  return (
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
      onTaskModeChange={setTaskMode}
    />
  );
}
