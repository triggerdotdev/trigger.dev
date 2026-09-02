import {
  createChat,
  createDashboardAgentDb,
  listChats,
  persistMessages,
  setChatPinned,
  type DashboardAgentDb,
  type DashboardAgentDbClient,
} from "@internal/dashboard-agent-db";
import { applyDashboardAgentMigrations } from "@internal/dashboard-agent-db/testing";
import { postgresTest } from "@internal/testcontainers";
import type { PrismaClient } from "@trigger.dev/database";
import { afterEach, describe, expect } from "vitest";

let agentDbClient: DashboardAgentDbClient | undefined;

async function boot(prisma: PrismaClient, connectionUri: string): Promise<DashboardAgentDb> {
  await applyDashboardAgentMigrations((statement) => prisma.$executeRawUnsafe(statement));
  agentDbClient = createDashboardAgentDb(connectionUri, { max: 2 });
  return agentDbClient.db;
}

afterEach(async () => {
  await agentDbClient?.close();
  agentDbClient = undefined;
});

const ORG = "org_owner";
const USER = "user_owner";

describe("listChats hides empty chats", () => {
  postgresTest(
    "a chat with no messages is left out, a pinned empty chat is kept",
    async ({ prisma, postgresContainer }) => {
      const db = await boot(prisma, postgresContainer.getConnectionUri());

      await createChat(db, { id: "chat_empty", organizationId: ORG, userId: USER });
      await createChat(db, { id: "chat_pinned_empty", organizationId: ORG, userId: USER });
      await setChatPinned(db, {
        chatId: "chat_pinned_empty",
        userId: USER,
        organizationId: ORG,
        pinned: true,
      });

      const withoutMessages = await listChats(db, { organizationId: ORG, userId: USER });
      expect(withoutMessages.map((chat) => chat.id).sort()).toEqual(["chat_pinned_empty"]);

      await createChat(db, { id: "chat_with_message", organizationId: ORG, userId: USER });
      await persistMessages(db, {
        chatId: "chat_with_message",
        messages: [{ id: "m1", role: "user", parts: [{ type: "text", text: "hi" }] }],
      });

      const withMessages = await listChats(db, { organizationId: ORG, userId: USER });
      expect(withMessages.map((chat) => chat.id).sort()).toEqual([
        "chat_pinned_empty",
        "chat_with_message",
      ]);
    },
    30_000
  );
});
