"use server";

import { auth } from "@trigger.dev/sdk";
import type { ResolveChatAccessTokenParams } from "@trigger.dev/sdk/chat";
import type { aiChat, aiChatRaw, aiChatSession } from "@/trigger/chat";
import type { ChatUiMessage } from "@/lib/chat-tools";
import { prisma } from "@/lib/prisma";

/** Short-lived PATs for local testing of expiry + `renewRunAccessToken` (not for production). */
const CHAT_EXAMPLE_PAT_TTL = "1h" as const;

export type ChatReferenceTaskId = "ai-chat" | "ai-chat-raw" | "ai-chat-session";

function isChatReferenceTaskId(id: string): id is ChatReferenceTaskId {
  return id === "ai-chat" || id === "ai-chat-raw" || id === "ai-chat-session";
}

/** Keeps compile-time alignment with exported chat tasks. */
type TaskIdentifierForChat =
  | (typeof aiChat)["id"]
  | (typeof aiChatRaw)["id"]
  | (typeof aiChatSession)["id"];

export async function getChatToken(
  input: ResolveChatAccessTokenParams & { taskId?: string }
): Promise<string> {
  const id = input.taskId ?? "ai-chat";
  const task: TaskIdentifierForChat = !isChatReferenceTaskId(id) ? "ai-chat" : id;
  return auth.createTriggerPublicToken(task, { expirationTime: CHAT_EXAMPLE_PAT_TTL });
}

/**
 * Mint a fresh run-scoped PAT for an existing chat run (same scopes as the task’s turn token).
 * Used by TriggerChatTransport when the stored PAT expires (401 on realtime / input stream).
 * Persists `publicAccessToken` (and `runId`) on `ChatSession` for this `chatId`.
 * Requires TRIGGER_SECRET_KEY (or configured secret) in the server environment.
 */
export async function renewRunAccessTokenForChat(
  chatId: string,
  runId: string
): Promise<string | undefined> {
  try {
    const token = await auth.createPublicToken({
      scopes: {
        read: { runs: runId },
        write: { inputStreams: runId },
      },
      expirationTime: CHAT_EXAMPLE_PAT_TTL,
    });

    if (typeof token !== "string" || token.length === 0) {
      return undefined;
    }

    await prisma.chatSession.upsert({
      where: { id: chatId },
      create: { id: chatId, runId, publicAccessToken: token },
      update: { runId, publicAccessToken: token },
    });

    return token;
  } catch {
    return undefined;
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
  await prisma.chat.delete({ where: { id: chatId } }).catch(() => { });
  await prisma.chatSession.delete({ where: { id: chatId } }).catch(() => { });
}

export async function updateChatTitle(chatId: string, title: string) {
  await prisma.chat.update({ where: { id: chatId }, data: { title } }).catch(() => { });
}

export async function updateSessionLastEventId(chatId: string, lastEventId: string) {
  await prisma.chatSession.update({ where: { id: chatId }, data: { lastEventId } }).catch(() => { });
}

export async function deleteSessionAction(chatId: string) {
  await prisma.chatSession.delete({ where: { id: chatId } }).catch(() => { });
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
