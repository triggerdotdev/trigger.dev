"use server";

import { auth } from "@trigger.dev/sdk";
import { chat } from "@trigger.dev/sdk/ai";
import type { ResolveChatAccessTokenParams } from "@trigger.dev/sdk/chat";
import type { aiChat, aiChatHydrated, aiChatRaw, aiChatSession } from "@/trigger/chat";
import type { ChatUiMessage } from "@/lib/chat-tools";
import { prisma } from "@/lib/prisma";

/** Short-lived PATs for local testing of expiry + `renewRunAccessToken` (not for production). */
const CHAT_EXAMPLE_PAT_TTL = "1h" as const;

export type ChatReferenceTaskId =
  | "ai-chat"
  | "ai-chat-hydrated"
  | "ai-chat-raw"
  | "ai-chat-session";

function isChatReferenceTaskId(id: string): id is ChatReferenceTaskId {
  return (
    id === "ai-chat" ||
    id === "ai-chat-hydrated" ||
    id === "ai-chat-raw" ||
    id === "ai-chat-session"
  );
}

/** Keeps compile-time alignment with exported chat tasks. */
type TaskIdentifierForChat =
  | (typeof aiChat)["id"]
  | (typeof aiChatHydrated)["id"]
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
 * Server-side trigger action — delegates run creation to the server.
 * Pass this to `useTriggerChatTransport({ triggerTask: triggerChat })`.
 */
export const triggerChat = chat.createTriggerAction("ai-chat", {
  tokenTTL: CHAT_EXAMPLE_PAT_TTL,
});

/**
 * Mint a fresh PAT for an existing chat (same scopes as the task's turn
 * token). Used by TriggerChatTransport when the stored PAT expires (401
 * on realtime / input stream). Persists `publicAccessToken` (and
 * `runId`) on `ChatSession` for this `chatId`. Requires
 * TRIGGER_SECRET_KEY (or configured secret) in the server environment.
 *
 * Scopes match the initial `chat.createTriggerAction` mint so the PAT
 * stays valid against both run-scoped endpoints (run PAT renewal, input
 * streams) and session-scoped endpoints (`/realtime/v1/sessions/…/in` +
 * `/realtime/v1/sessions/…/out`). Without the session scopes, the
 * renewed token 401s on the session append path the transport uses.
 */
export async function renewRunAccessTokenForChat(
  chatId: string,
  runId: string,
  sessionId?: string
): Promise<string | undefined> {
  try {
    const token = await auth.createPublicToken({
      scopes: {
        read: {
          runs: runId,
          ...(sessionId ? { sessions: sessionId } : {}),
        },
        write: {
          inputStreams: runId,
          ...(sessionId ? { sessions: sessionId } : {}),
        },
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

export async function deleteAllChats() {
  await prisma.chatSession.deleteMany();
  await prisma.chat.deleteMany();
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

export async function getSessionForChat(chatId: string) {
  const session = await prisma.chatSession.findUnique({ where: { id: chatId } });
  if (!session) return null;
  return {
    sessionId: session.sessionId ?? undefined,
    runId: session.runId,
    publicAccessToken: session.publicAccessToken,
    lastEventId: session.lastEventId ?? undefined,
  };
}

export async function getAllSessions() {
  const sessions = await prisma.chatSession.findMany();
  const result: Record<
    string,
    { sessionId?: string; runId: string; publicAccessToken: string; lastEventId?: string }
  > = {};
  for (const s of sessions) {
    result[s.id] = {
      sessionId: s.sessionId ?? undefined,
      runId: s.runId,
      publicAccessToken: s.publicAccessToken,
      lastEventId: s.lastEventId ?? undefined,
    };
  }
  return result;
}
