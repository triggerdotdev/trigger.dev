import {
  createChat,
  createDashboardAgentDb,
  type DashboardAgentDb,
  type DashboardAgentDbClient,
} from "@internal/dashboard-agent-db";
import { postgresTest } from "@internal/testcontainers";
import type { PrismaClient } from "@trigger.dev/database";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, vi } from "vitest";

const ctx = vi.hoisted(() => ({
  agentDb: undefined as unknown as DashboardAgentDb,
}));

vi.mock("~/services/dashboardAgentDb.server", () => ({
  get dashboardAgentDb() {
    return ctx.agentDb;
  },
}));

const { purgeDashboardAgentChatsForOrganization } =
  await import("~/services/dashboardAgentChatRetention.server");

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

async function boot(prisma: PrismaClient, connectionUri: string) {
  await applyAgentSchema(prisma);
  agentDbClient = createDashboardAgentDb(connectionUri, { max: 2 });
  ctx.agentDb = agentDbClient.db;
}

afterEach(async () => {
  await agentDbClient?.close();
  agentDbClient = undefined;
});

const ORG = "org_ret";
const USER = "user_ret";

describe("the dashboard agent chat org purge", () => {
  postgresTest(
    "org purge soft-deletes the org's chats and leaves other orgs alone",
    async ({ prisma, postgresContainer }) => {
      await boot(prisma, postgresContainer.getConnectionUri());

      await createChat(ctx.agentDb, { id: "chat_a", organizationId: ORG, userId: USER });
      await createChat(ctx.agentDb, { id: "chat_b", organizationId: ORG, userId: USER });
      await createChat(ctx.agentDb, {
        id: "chat_other",
        organizationId: "org_other",
        userId: USER,
      });

      const soft = await purgeDashboardAgentChatsForOrganization({ organizationId: ORG });
      expect(soft).toBe(2);

      const deleted = await prisma.$queryRawUnsafe<{ id: string; deleted: boolean }[]>(
        `select id, (deleted_at is not null) as deleted from trigger_dashboard_agent.chats order by id`
      );
      const byId = Object.fromEntries(deleted.map((row) => [row.id, row.deleted]));
      expect(byId).toEqual({ chat_a: true, chat_b: true, chat_other: false });

      // Idempotent: a second call touches nothing already soft-deleted.
      expect(await purgeDashboardAgentChatsForOrganization({ organizationId: ORG })).toBe(0);
    }
  );
});
