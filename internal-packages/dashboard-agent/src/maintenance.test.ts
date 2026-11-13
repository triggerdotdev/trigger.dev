import {
  createChat,
  createDashboardAgentDb,
  insertTurnEval,
  type DashboardAgentDb,
  type DashboardAgentDbClient,
} from "@internal/dashboard-agent-db";
import { applyDashboardAgentMigrations } from "@internal/dashboard-agent-db/testing";
import { postgresTest } from "@internal/testcontainers";
import { afterEach, describe, expect } from "vitest";
import { runDashboardAgentRetention, TURN_EVAL_RETENTION_MS } from "./maintenance";

const ORG = "org_retention";
const USER = "user_retention";

let client: DashboardAgentDbClient | undefined;

async function boot(connectionUri: string): Promise<DashboardAgentDb> {
  client = createDashboardAgentDb(connectionUri, { max: 2 });
  await applyDashboardAgentMigrations((statement) => client!.sql.unsafe(statement));
  return client.db;
}

function raw(statement: string, params: unknown[] = []) {
  return client!.sql.unsafe(statement, params as never[]);
}

afterEach(async () => {
  await client?.close();
  client = undefined;
});

async function seedTurnEval(
  db: DashboardAgentDb,
  args: { chatId: string; turn: number; ageMs: number }
) {
  await insertTurnEval(db, {
    chatId: args.chatId,
    turn: args.turn,
    organizationId: ORG,
    userId: USER,
    summary: "the user asked about a failed run",
  });
  await raw(
    `update trigger_dashboard_agent.chat_turn_evals
     set created_at = now() - ($3 || ' seconds')::interval
     where chat_id = $1 and turn = $2`,
    [args.chatId, args.turn, String(args.ageMs / 1000)]
  );
}

/** One row in every chatId-keyed table, so a delete that misses one leaves a leak. */
async function seedChatWithChildren(db: DashboardAgentDb, id: string) {
  await createChat(db, { id, organizationId: ORG, userId: USER });
  await raw(
    `insert into trigger_dashboard_agent.chat_messages (chat_id, message_id, position, role, message)
     values ($1, $1 || '-m', 1, 'user', '{}'::jsonb)`,
    [id]
  );
  await raw(
    `insert into trigger_dashboard_agent.chat_sessions (chat_id, public_access_token) values ($1, 'pat')`,
    [id]
  );
  await raw(
    `insert into trigger_dashboard_agent.chat_turn_evals (chat_id, turn, organization_id, user_id)
     values ($1, 0, $2, $3)`,
    [id, ORG, USER]
  );
  await raw(
    `insert into trigger_dashboard_agent.investigations (id, chat_id, project_ref, environment_ref, state)
     values ($1 || '-inv', $1, 'proj', 'env', '{"outcome":"in_progress"}'::jsonb)`,
    [id]
  );
}

const CHILD_TABLES = ["chat_messages", "chat_sessions", "chat_turn_evals", "investigations"];

async function rowCounts(id: string): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const table of ["chats", ...CHILD_TABLES]) {
    const column = table === "chats" ? "id" : "chat_id";
    const rows = await raw(
      `select count(*)::int as n from trigger_dashboard_agent.${table} where ${column} = $1`,
      [id]
    );
    counts[table] = Number((rows as unknown as { n: number }[])[0]!.n);
  }
  return counts;
}

async function count(table: string): Promise<number> {
  const rows = await raw(`select count(*)::int as n from trigger_dashboard_agent.${table}`);
  return Number((rows as unknown as { n: number }[])[0]!.n);
}

describe("the dashboard agent retention pass", () => {
  postgresTest(
    "drops turn evals and soft-deleted chats past their windows",
    async ({ postgresContainer }) => {
      const db = await boot(postgresContainer.getConnectionUri());

      await createChat(db, { id: "chat_evals", organizationId: ORG, userId: USER });
      await seedTurnEval(db, {
        chatId: "chat_evals",
        turn: 0,
        ageMs: TURN_EVAL_RETENTION_MS + 60_000,
      });
      await seedTurnEval(db, { chatId: "chat_evals", turn: 1, ageMs: 0 });

      await createChat(db, { id: "chat_gone", organizationId: ORG, userId: USER });
      await createChat(db, { id: "chat_kept", organizationId: ORG, userId: USER });
      await raw(
        `update trigger_dashboard_agent.chats set deleted_at = now() - interval '40 days' where id = 'chat_gone'`
      );
      await raw(
        `update trigger_dashboard_agent.chats set deleted_at = now() - interval '1 day' where id = 'chat_kept'`
      );

      expect(await runDashboardAgentRetention(db)).toEqual({
        turnEvals: 1,
        chats: 1,
      });

      expect(await count("chat_turn_evals")).toBe(1);
      const chats = await raw(`select id from trigger_dashboard_agent.chats order by id`);
      expect((chats as unknown as { id: string }[]).map((row) => row.id)).toEqual([
        "chat_evals",
        "chat_kept",
      ]);
    },
    60_000
  );

  postgresTest(
    "a purged chat takes every chatId-keyed child row with it",
    async ({ postgresContainer }) => {
      const db = await boot(postgresContainer.getConnectionUri());

      await seedChatWithChildren(db, "chat_cascade_old");
      await seedChatWithChildren(db, "chat_cascade_new");
      await raw(
        `update trigger_dashboard_agent.chats set deleted_at = now() - interval '40 days' where id = 'chat_cascade_old'`
      );
      await raw(
        `update trigger_dashboard_agent.chats set deleted_at = now() - interval '1 day' where id = 'chat_cascade_new'`
      );

      expect(await runDashboardAgentRetention(db)).toMatchObject({ chats: 1 });

      const purged = await rowCounts("chat_cascade_old");
      const kept = await rowCounts("chat_cascade_new");
      for (const table of ["chats", ...CHILD_TABLES]) {
        expect(purged[table], `${table} should be empty for the purged chat`).toBe(0);
        expect(kept[table], `${table} kept for the in-window chat`).toBe(1);
      }
    },
    60_000
  );

  postgresTest(
    "drains a backlog over several batches instead of leaving it for tomorrow",
    async ({ postgresContainer }) => {
      const db = await boot(postgresContainer.getConnectionUri());
      await createChat(db, { id: "chat_backlog", organizationId: ORG, userId: USER });
      for (let turn = 0; turn < 5; turn++) {
        await seedTurnEval(db, {
          chatId: "chat_backlog",
          turn,
          ageMs: TURN_EVAL_RETENTION_MS + 60_000,
        });
      }

      expect(await runDashboardAgentRetention(db, { limit: 1 })).toEqual({
        turnEvals: 5,
        chats: 0,
      });
      expect(await count("chat_turn_evals")).toBe(0);
    },
    60_000
  );

  postgresTest(
    "the batch cap bounds one run, and the rest goes next run",
    async ({ postgresContainer }) => {
      const db = await boot(postgresContainer.getConnectionUri());
      await createChat(db, { id: "chat_capped", organizationId: ORG, userId: USER });
      for (let turn = 0; turn < 5; turn++) {
        await seedTurnEval(db, {
          chatId: "chat_capped",
          turn,
          ageMs: TURN_EVAL_RETENTION_MS + 60_000,
        });
      }

      expect(await runDashboardAgentRetention(db, { limit: 2, maxBatches: 2 })).toMatchObject({
        turnEvals: 4,
      });
      expect(await count("chat_turn_evals")).toBe(1);

      expect(await runDashboardAgentRetention(db, { limit: 2, maxBatches: 2 })).toMatchObject({
        turnEvals: 1,
      });
      expect(await count("chat_turn_evals")).toBe(0);
    },
    60_000
  );

  postgresTest(
    "one failing pass doesn't cost the others, and the run throws so the job retries",
    async ({ postgresContainer }) => {
      const db = await boot(postgresContainer.getConnectionUri());
      await createChat(db, { id: "chat_failing", organizationId: ORG, userId: USER });
      await seedTurnEval(db, {
        chatId: "chat_failing",
        turn: 0,
        ageMs: TURN_EVAL_RETENTION_MS + 60_000,
      });
      await raw(
        `update trigger_dashboard_agent.chats set deleted_at = now() - interval '40 days' where id = 'chat_failing'`
      );

      await expect(
        runDashboardAgentRetention(db, {
          purgeTurnEvals: async () => {
            throw new Error("the turn eval purge failed");
          },
        })
      ).rejects.toThrow(/turn evals/);

      // The pass after the failing one still ran.
      expect(await count("chats")).toBe(0);
    },
    60_000
  );
});
