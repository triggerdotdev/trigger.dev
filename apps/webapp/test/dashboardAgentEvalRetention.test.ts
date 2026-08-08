import {
  createDashboardAgentDb,
  insertTurnEval,
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

const { sweepDashboardAgentTurnEvals, TURN_EVAL_RETENTION_MS } =
  await import("~/services/dashboardAgentEvalRetention.server");

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

async function seedEval(args: { chatId: string; turn: number; ageMs: number }) {
  await insertTurnEval(ctx.agentDb, {
    chatId: args.chatId,
    turn: args.turn,
    organizationId: "org_retention",
    userId: "user_retention",
    summary: "the user asked about a failed run",
  });
  await prismaForRaw!.$executeRawUnsafe(
    `update trigger_dashboard_agent.chat_turn_evals
     set created_at = now() - ($3 || ' seconds')::interval
     where chat_id = $1 and turn = $2`,
    args.chatId,
    args.turn,
    String(args.ageMs / 1000)
  );
}

async function remaining(): Promise<Array<{ chat_id: string; turn: number }>> {
  return prismaForRaw!.$queryRawUnsafe(
    `select chat_id, turn from trigger_dashboard_agent.chat_turn_evals order by chat_id, turn`
  );
}

describe("dashboard agent turn-eval retention", () => {
  postgresTest(
    "drops only rows past the retention period",
    async ({ prisma, postgresContainer }) => {
      await boot(prisma, postgresContainer.getConnectionUri());

      await seedEval({ chatId: "chat_old", turn: 0, ageMs: TURN_EVAL_RETENTION_MS + 60_000 });
      await seedEval({ chatId: "chat_edge", turn: 0, ageMs: TURN_EVAL_RETENTION_MS - 60_000 });
      await seedEval({ chatId: "chat_new", turn: 0, ageMs: 0 });

      const result = await sweepDashboardAgentTurnEvals();
      expect(result).toEqual({ purged: 1, failed: 0 });

      const rows = await remaining();
      expect(rows.map((row) => row.chat_id)).toEqual(["chat_edge", "chat_new"]);
    }
  );

  postgresTest(
    "stops at the batch cap and drains on the next run",
    async ({ prisma, postgresContainer }) => {
      await boot(prisma, postgresContainer.getConnectionUri());

      for (let turn = 0; turn < 5; turn++) {
        await seedEval({
          chatId: "chat_backlog",
          turn,
          // Oldest first, so the cap takes a deterministic slice.
          ageMs: TURN_EVAL_RETENTION_MS + 60_000 + (5 - turn) * 1_000,
        });
      }

      const first = await sweepDashboardAgentTurnEvals({ limit: 2 });
      expect(first).toEqual({ purged: 2, failed: 0 });
      expect(await remaining()).toHaveLength(3);

      const second = await sweepDashboardAgentTurnEvals({ limit: 2 });
      expect(second).toEqual({ purged: 2, failed: 0 });

      const third = await sweepDashboardAgentTurnEvals({ limit: 2 });
      expect(third).toEqual({ purged: 1, failed: 0 });
      expect(await remaining()).toHaveLength(0);
    }
  );

  postgresTest(
    "keeps everything when nothing is old enough",
    async ({ prisma, postgresContainer }) => {
      await boot(prisma, postgresContainer.getConnectionUri());
      await seedEval({ chatId: "chat_fresh", turn: 0, ageMs: 0 });

      expect(await sweepDashboardAgentTurnEvals()).toEqual({ purged: 0, failed: 0 });
      expect(await remaining()).toHaveLength(1);
    }
  );
});
