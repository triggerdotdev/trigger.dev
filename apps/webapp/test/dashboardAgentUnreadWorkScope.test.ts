/**
 * The launcher's work count leaves out the chat the panel has on screen, because that chat is
 * being read as the count is taken. Leaving it out is not the same as subtracting one: a chat
 * on screen holding nothing unseen must take nothing off the chats that do.
 */

import {
  countChatsWithUnreadWork,
  createDashboardAgentDb,
  type DashboardAgentDb,
  type DashboardAgentDbClient,
} from "@internal/dashboard-agent-db";
import { applyDashboardAgentMigrations } from "@internal/dashboard-agent-db/testing";
import { postgresTest } from "@internal/testcontainers";
import type { PrismaClient } from "@trigger.dev/database";
import { afterEach, describe, expect } from "vitest";

const SCOPE = { organizationId: "org_1", userId: "user_1" };

const MESSAGED_AT = new Date("2026-02-01T00:00:00.000Z");
const READ_AFTER = new Date("2026-03-01T00:00:00.000Z");

async function seedChat(prisma: PrismaClient, id: string, readAt: Date | null) {
  await prisma.$executeRawUnsafe(
    `insert into "trigger_dashboard_agent"."chats"
       ("id", "organization_id", "user_id", "created_at", "updated_at", "last_message_at", "last_read_at")
     values ($1, $2, $3, $4, $4, $4, $5)`,
    id,
    SCOPE.organizationId,
    SCOPE.userId,
    MESSAGED_AT,
    readAt
  );
}

let agentDbClient: DashboardAgentDbClient | undefined;

afterEach(async () => {
  await agentDbClient?.close();
  agentDbClient = undefined;
});

describe("the chat the panel has on screen", () => {
  postgresTest(
    "is left out of the work count, and only it",
    async ({ prisma, postgresContainer }) => {
      await applyDashboardAgentMigrations((statement) => prisma.$executeRawUnsafe(statement));
      agentDbClient = createDashboardAgentDb(postgresContainer.getConnectionUri(), { max: 2 });
      const agentDb: DashboardAgentDb = agentDbClient.db;

      await seedChat(prisma, "chat_on_screen", null);
      await seedChat(prisma, "chat_elsewhere", null);
      await seedChat(prisma, "chat_settled", READ_AFTER);

      expect(await countChatsWithUnreadWork(agentDb, SCOPE)).toBe(2);

      // A turn landing in the chat on screen is not work anyone is waiting on.
      expect(
        await countChatsWithUnreadWork(agentDb, { ...SCOPE, excludeChatId: "chat_on_screen" })
      ).toBe(1);

      // And the chat on screen holding nothing unseen takes nothing off the rest.
      expect(
        await countChatsWithUnreadWork(agentDb, { ...SCOPE, excludeChatId: "chat_settled" })
      ).toBe(2);
    }
  );
});
