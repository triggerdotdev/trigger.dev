import {
  createChat,
  createDashboardAgentDb,
  listChats,
  softDeleteChat,
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
const OTHER_ORG = "org_other";
const USER = "user_owner";

describe("softDeleteChat tenant isolation", () => {
  postgresTest(
    "a soft-delete scoped to another org leaves the chat intact",
    async ({ prisma, postgresContainer }) => {
      const db = await boot(prisma, postgresContainer.getConnectionUri());

      await createChat(db, { id: "chat_1", organizationId: ORG, userId: USER });

      // Right user, wrong org: must not delete.
      const wrongOrg = await softDeleteChat(db, {
        chatId: "chat_1",
        userId: USER,
        organizationId: OTHER_ORG,
      });
      expect(wrongOrg.deleted).toBe(false);
      expect(await listChats(db, { organizationId: ORG, userId: USER })).toHaveLength(1);

      // Right org and user: deletes.
      const rightOrg = await softDeleteChat(db, {
        chatId: "chat_1",
        userId: USER,
        organizationId: ORG,
      });
      expect(rightOrg.deleted).toBe(true);
      expect(await listChats(db, { organizationId: ORG, userId: USER })).toHaveLength(0);
    },
    30_000
  );

  postgresTest(
    "deleting twice is a no-op: the retention cutoff doesn't move",
    async ({ prisma, postgresContainer }) => {
      const db = await boot(prisma, postgresContainer.getConnectionUri());
      const deletedAt = async () =>
        (
          await prisma.$queryRawUnsafe<{ deleted_at: Date | null }[]>(
            `select deleted_at from trigger_dashboard_agent.chats where id = 'chat_1'`
          )
        )[0]?.deleted_at;

      await createChat(db, { id: "chat_1", organizationId: ORG, userId: USER });
      const params = { chatId: "chat_1", userId: USER, organizationId: ORG };

      expect((await softDeleteChat(db, params)).deleted).toBe(true);
      const first = await deletedAt();
      expect(first).toBeInstanceOf(Date);

      // A retry finds nothing left to delete, so the stamp stands.
      expect((await softDeleteChat(db, params)).deleted).toBe(false);
      expect(await deletedAt()).toEqual(first);
    },
    30_000
  );
});
