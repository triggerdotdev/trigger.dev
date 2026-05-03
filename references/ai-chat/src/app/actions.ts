"use server";

import { auth } from "@trigger.dev/sdk";
import { chat } from "@trigger.dev/sdk/ai";
import type {
  aiChat,
  aiChatHydrated,
  aiChatRaw,
  aiChatSession,
  upgradeTestAgent,
} from "@/trigger/chat";
import type { ChatUiMessage } from "@/lib/chat-tools-schemas";
import { prisma } from "@/lib/prisma";

/** Short-lived PATs for local testing of expiry + renewal (not for production). */
const CHAT_EXAMPLE_PAT_TTL = "1h" as const;

export type ChatReferenceTaskId =
  | "ai-chat"
  | "ai-chat-hydrated"
  | "ai-chat-raw"
  | "ai-chat-session"
  | "upgrade-test";

function isChatReferenceTaskId(id: string): id is ChatReferenceTaskId {
  return (
    id === "ai-chat" ||
    id === "ai-chat-hydrated" ||
    id === "ai-chat-raw" ||
    id === "ai-chat-session" ||
    id === "upgrade-test"
  );
}

/** Keeps compile-time alignment with exported chat tasks. */
type TaskIdentifierForChat =
  | (typeof aiChat)["id"]
  | (typeof aiChatHydrated)["id"]
  | (typeof aiChatRaw)["id"]
  | (typeof aiChatSession)["id"]
  | (typeof upgradeTestAgent)["id"];

/**
 * Server-mediated start: creates the Session row + triggers the first
 * run via secret-key access, returns the session-scoped PAT for the
 * browser to use. Wired into the transport's `startSession` callback —
 * the transport invokes it on `transport.preload(chatId)` and lazily on
 * the first `sendMessage` for any chatId without a cached PAT.
 *
 * The browser never sees a `start` token in this path; the customer's
 * server keeps the secret.
 *
 * `clientData` flows through from the transport's typed `clientData`
 * option — same value the transport merges into per-turn `metadata`
 * — and lands in `triggerConfig.basePayload.metadata` so the first
 * run's `payload.metadata` (visible to `onPreload` / `onChatStart`)
 * matches what subsequent turns see. Server-side authorization can
 * still override or augment what the browser claims (e.g. ignore a
 * spoofed userId and substitute the request-session's userId).
 */
const startChatSessionFor = (taskId: TaskIdentifierForChat) =>
  chat.createStartSessionAction(taskId, { tokenTTL: CHAT_EXAMPLE_PAT_TTL });

const startActionByTaskId: Record<
  ChatReferenceTaskId,
  ReturnType<typeof startChatSessionFor>
> = {
  "ai-chat": startChatSessionFor("ai-chat"),
  "ai-chat-hydrated": startChatSessionFor("ai-chat-hydrated"),
  "ai-chat-raw": startChatSessionFor("ai-chat-raw"),
  "ai-chat-session": startChatSessionFor("ai-chat-session"),
  "upgrade-test": startChatSessionFor("upgrade-test"),
};

export async function startChatSession(input: {
  chatId: string;
  taskId?: string;
  clientData?: Record<string, unknown>;
}): Promise<{ publicAccessToken: string }> {
  const id = input.taskId ?? "ai-chat";
  const taskId: ChatReferenceTaskId = !isChatReferenceTaskId(id) ? "ai-chat" : id;

  // `clientData` arrives from the transport's typed `clientData` option.
  // In a real app the server would also resolve the user from the
  // request session and merge/override accordingly — never trust the
  // browser-claimed identity. The reference demo just trusts it.
  const result = await startActionByTaskId[taskId]({
    chatId: input.chatId,
    triggerConfig: input.clientData
      ? { basePayload: { metadata: input.clientData } }
      : undefined,
  });

  // Persist the latest PAT alongside the chat so a fresh tab can
  // hydrate without going through the start callback again.
  await prisma.chatSession
    .upsert({
      where: { id: input.chatId },
      create: { id: input.chatId, publicAccessToken: result.publicAccessToken },
      update: { publicAccessToken: result.publicAccessToken },
    })
    .catch(() => {
      /* best-effort persistence */
    });

  return { publicAccessToken: result.publicAccessToken };
}

/**
 * Mint a session-scoped PAT for a chatId. Pure: just calls
 * `auth.createPublicToken` with `read:sessions:{chatId}` +
 * `write:sessions:{chatId}` scopes — no DB writes, no session
 * creation, no run triggering.
 *
 * The transport's `accessToken` callback wraps this. It fires on
 * initial use (when no PAT is hydrated) and on 401/403 refresh.
 * Session creation happens separately via `startChatSession` at page
 * load — keeping these concerns split avoids re-triggering runs every
 * time a PAT expires.
 */
export async function mintChatAccessToken(chatId: string): Promise<string> {
  return auth.createPublicToken({
    scopes: {
      read: { sessions: chatId },
      write: { sessions: chatId },
    },
    expirationTime: CHAT_EXAMPLE_PAT_TTL,
  });
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
  await prisma.chatSession
    .update({ where: { id: chatId }, data: { lastEventId } })
    .catch(() => { });
}

export async function deleteSessionAction(chatId: string) {
  await prisma.chatSession.delete({ where: { id: chatId } }).catch(() => { });
}

export async function getSessionForChat(chatId: string) {
  const session = await prisma.chatSession.findUnique({ where: { id: chatId } });
  if (!session) return null;
  return {
    publicAccessToken: session.publicAccessToken,
    lastEventId: session.lastEventId ?? undefined,
  };
}

export async function getAllSessions() {
  const sessions = await prisma.chatSession.findMany();
  const result: Record<string, { publicAccessToken: string; lastEventId?: string }> = {};
  for (const s of sessions) {
    result[s.id] = {
      publicAccessToken: s.publicAccessToken,
      lastEventId: s.lastEventId ?? undefined,
    };
  }
  return result;
}
