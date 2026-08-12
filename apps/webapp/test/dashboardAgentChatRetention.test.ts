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

const { sweepDashboardAgentSoftDeletedChats, purgeDashboardAgentChatsForOrganization } =
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
let prismaForRaw: PrismaClient | undefined;

async function boot(prisma: PrismaClient, connectionUri: string) {
  await applyAgentSchema(prisma);
  agentDbClient = createDashboardAgentDb(connectionUri, { max: 2 });
  ctx.agentDb = agentDbClient.db;
  prismaForRaw = prisma;
}

afterEach(async () => {
  await agentDbClient?.close();
  agentDbClient = undefined;
});

const ORG = "org_ret";
const USER = "user_ret";

/** One row in every chatId-keyed table, so a delete that misses one leaves a leak. */
async function seedChatWithChildren(id: string) {
  await createChat(ctx.agentDb, { id, organizationId: ORG, userId: USER });
  const raw = prismaForRaw!;
  await raw.$executeRawUnsafe(
    `insert into trigger_dashboard_agent.chat_messages (chat_id, message_id, position, role, message)
     values ($1, $1 || '-m', 1, 'user', '{}'::jsonb)`,
    id
  );
  await raw.$executeRawUnsafe(
    `insert into trigger_dashboard_agent.chat_sessions (chat_id, public_access_token) values ($1, 'pat')`,
    id
  );
  await raw.$executeRawUnsafe(
    `insert into trigger_dashboard_agent.chat_turn_evals (chat_id, turn, organization_id, user_id)
     values ($1, 0, $2, $3)`,
    id,
    ORG,
    USER
  );
  await raw.$executeRawUnsafe(
    `insert into trigger_dashboard_agent.investigations (id, chat_id, project_ref, environment_ref, state)
     values ($1 || '-inv', $1, 'proj', 'env', '{"outcome":"in_progress"}'::jsonb)`,
    id
  );
  await raw.$executeRawUnsafe(
    `insert into trigger_dashboard_agent.watches
       (id, chat_id, identity, spec, organization_id, project_id, environment_id, user_id, expires_at)
     values ($1 || '-w', $1, 'ident', '{}'::jsonb, $2, 'proj', 'env', $3, now() + interval '1 day')`,
    id,
    ORG,
    USER
  );
  await raw.$executeRawUnsafe(
    `insert into trigger_dashboard_agent.watch_submissions
       (chat_id, client_request_id, organization_id, user_id, project_id, environment_id, draft_hash, draft)
     values ($1, 'req', $2, $3, 'proj', 'env', 'hash', '{}'::jsonb)`,
    id,
    ORG,
    USER
  );
}

async function setDeletedAtDaysAgo(id: string, days: number) {
  await prismaForRaw!.$executeRawUnsafe(
    `update trigger_dashboard_agent.chats set deleted_at = now() - ($2 || ' days')::interval where id = $1`,
    id,
    String(days)
  );
}

const CHILD_TABLES = [
  "chat_messages",
  "chat_sessions",
  "chat_turn_evals",
  "investigations",
  "watches",
  "watch_submissions",
];

async function rowCounts(id: string): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  const chat = await prismaForRaw!.$queryRawUnsafe<{ n: bigint }[]>(
    `select count(*)::int as n from trigger_dashboard_agent.chats where id = $1`,
    id
  );
  counts.chats = Number(chat[0]!.n);
  for (const table of CHILD_TABLES) {
    const rows = await prismaForRaw!.$queryRawUnsafe<{ n: number }[]>(
      `select count(*)::int as n from trigger_dashboard_agent.${table} where chat_id = $1`,
      id
    );
    counts[table] = Number(rows[0]!.n);
  }
  return counts;
}

describe("the dashboard agent chat retention sweep", () => {
  postgresTest(
    "hard-deletes only chats soft-deleted past the window, with every child row",
    async ({ prisma, postgresContainer }) => {
      await boot(prisma, postgresContainer.getConnectionUri());

      await seedChatWithChildren("chat_old");
      await setDeletedAtDaysAgo("chat_old", 40); // past the 30d window

      await seedChatWithChildren("chat_recent");
      await setDeletedAtDaysAgo("chat_recent", 1); // inside the window

      await seedChatWithChildren("chat_live"); // never deleted

      const result = await sweepDashboardAgentSoftDeletedChats();
      expect(result).toEqual({ purged: 1, failed: 0 });

      const old = await rowCounts("chat_old");
      for (const table of ["chats", ...CHILD_TABLES]) {
        expect(old[table], `${table} should be empty for the purged chat`).toBe(0);
      }

      const recent = await rowCounts("chat_recent");
      const live = await rowCounts("chat_live");
      for (const table of ["chats", ...CHILD_TABLES]) {
        expect(recent[table], `${table} kept for the in-window chat`).toBe(1);
        expect(live[table], `${table} kept for the live chat`).toBe(1);
      }
    },
    30_000
  );

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
