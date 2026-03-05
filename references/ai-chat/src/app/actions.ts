"use server";

import { chat } from "@trigger.dev/sdk/ai";
import type { aiChat } from "@/trigger/chat";
import { prisma } from "@/lib/prisma";

export const getChatToken = async () => chat.createAccessToken<typeof aiChat>("ai-chat");

export async function getChatList() {
  const chats = await prisma.chat.findMany({
    select: { id: true, title: true, createdAt: true, updatedAt: true },
    orderBy: { updatedAt: "desc" },
  });
  return chats.map((c) => ({
    id: c.id,
    title: c.title,
    createdAt: c.createdAt.getTime(),
    updatedAt: c.updatedAt.getTime(),
  }));
}

export async function getChatMessages(chatId: string) {
  const found = await prisma.chat.findUnique({ where: { id: chatId } });
  if (!found) return [];
  return found.messages as any[];
}

export async function deleteChat(chatId: string) {
  await prisma.chat.delete({ where: { id: chatId } }).catch(() => {});
  await prisma.chatSession.delete({ where: { id: chatId } }).catch(() => {});
}

export async function updateChatTitle(chatId: string, title: string) {
  await prisma.chat.update({ where: { id: chatId }, data: { title } }).catch(() => {});
}

export async function updateSessionLastEventId(chatId: string, lastEventId: string) {
  await prisma.chatSession
    .update({ where: { id: chatId }, data: { lastEventId } })
    .catch(() => {});
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
