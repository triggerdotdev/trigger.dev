import {
  createChat,
  createDashboardAgentDb,
  listChats,
  softDeleteChat,
  type DashboardAgentDb,
  type DashboardAgentDbClient,
} from "@internal/dashboard-agent-db";
import { postgresTest } from "@internal/testcontainers";
import type { PrismaClient } from "@trigger.dev/database";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect } from "vitest";

/** Replays every migration in order, so a new migration can't leave the suite on a stale schema. */
async function applyAgentSchema(prisma: PrismaClient) {
  const folder = path.resolve(__dirname, "../../../internal-packages/dashboard-agent-db/drizzle");
  const migrations = readdirSync(folder)
    .filter((file) => file.endsWith(".sql"))
    .sort();
  for (const name of migrations) {
    const sql = readFileSync(path.join(folder, name), "utf8");
    for (const statement of sql.split("--> statement-breakpoint")) {
      const trimmed = statement.trim();
      if (trimmed.length > 0) await prisma.$executeRawUnsafe(trimmed);
    }
  }
}

let agentDbClient: DashboardAgentDbClient | undefined;

async function boot(prisma: PrismaClient, connectionUri: string): Promise<DashboardAgentDb> {
  await applyAgentSchema(prisma);
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
