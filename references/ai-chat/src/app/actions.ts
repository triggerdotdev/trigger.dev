"use server";

import { chat } from "@trigger.dev/sdk/ai";
import type { aiChat, aiChatRaw, aiChatSession } from "@/trigger/chat";
import type { ChatUiMessage } from "@/lib/chat-tools";
import { prisma } from "@/lib/prisma";

export type ChatReferenceTaskId = "ai-chat" | "ai-chat-raw" | "ai-chat-session";

function isChatReferenceTaskId(id: string): id is ChatReferenceTaskId {
  return id === "ai-chat" || id === "ai-chat-raw" || id === "ai-chat-session";
}

export async function getChatToken(taskId?: string) {
  const id = taskId ?? "ai-chat";
  if (!isChatReferenceTaskId(id)) {
    return chat.createAccessToken<typeof aiChat>("ai-chat");
  }
  switch (id) {
    case "ai-chat":
      return chat.createAccessToken<typeof aiChat>(id);
    case "ai-chat-raw":
      return chat.createAccessToken<typeof aiChatRaw>(id);
    case "ai-chat-session":
      return chat.createAccessToken<typeof aiChatSession>(id);
  }
}

export async function getChatList() {
  const chats = await prisma.chat.findMany({
    select: { id: true, title: true, model: true, createdAt: true, updatedAt: true },
    orderBy: { updatedAt: "desc" },
  });
  return chats.map((c) => ({
    id: c.id,
    title: c.title,
    model: c.model,
    createdAt: c.createdAt.getTime(),
    updatedAt: c.updatedAt.getTime(),
  }));
}

export async function getChatMessages(chatId: string): Promise<ChatUiMessage[]> {
  const found = await prisma.chat.findUnique({ where: { id: chatId } });
  if (!found) return [];
  return found.messages as unknown as ChatUiMessage[];
}

export async function deleteChat(chatId: string) {
  await prisma.chat.delete({ where: { id: chatId } }).catch(() => {});
  await prisma.chatSession.delete({ where: { id: chatId } }).catch(() => {});
}

export async function updateChatTitle(chatId: string, title: string) {
  await prisma.chat.update({ where: { id: chatId }, data: { title } }).catch(() => {});
}

export async function updateSessionLastEventId(chatId: string, lastEventId: string) {
  await prisma.chatSession.update({ where: { id: chatId }, data: { lastEventId } }).catch(() => {});
}

export async function deleteSessionAction(chatId: string) {
  await prisma.chatSession.delete({ where: { id: chatId } }).catch(() => {});
}

export async function getAllSessions() {
  const sessions = await prisma.chatSession.findMany();
  const result: Record<string, { runId: string; publicAccessToken: string; lastEventId?: string }> =
    {};
  for (const s of sessions) {
    result[s.id] = {
      runId: s.runId,
      publicAccessToken: s.publicAccessToken,
      lastEventId: s.lastEventId ?? undefined,
    };
  }
  return result;
}
