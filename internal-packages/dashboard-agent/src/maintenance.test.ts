import {
  createChat,
  createDashboardAgentDb,
  insertTurnEval,
  type DashboardAgentDb,
  type DashboardAgentDbClient,
} from "@internal/dashboard-agent-db";
import { applyDashboardAgentMigrations } from "@internal/dashboard-agent-db/testing";
import { postgresTest } from "@internal/testcontainers";
import { afterEach, describe, expect, it } from "vitest";
import {
  maintenanceConnectionString,
  runDashboardAgentRetention,
  TURN_EVAL_RETENTION_MS,
} from "./maintenance";

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

async function seedTerminalWatch(id: string, chatId: string, ageDays: number) {
  await raw(
    `insert into trigger_dashboard_agent.watches
       (id, chat_id, identity, spec, organization_id, project_id, environment_id, user_id,
        status, delivery_status, expires_at, created_at)
     values ($1, $2, $1, '{}'::jsonb, $3, 'proj', 'env', $4,
        'expired', 'delivered', now(), now() - ($5 || ' days')::interval)`,
    [id, chatId, ORG, USER, String(ageDays)]
  );
}

async function seedSubmission(chatId: string, requestId: string, ageDays: number) {
  await raw(
    `insert into trigger_dashboard_agent.watch_submissions
       (chat_id, client_request_id, organization_id, user_id, project_id, environment_id,
        draft_hash, draft, created_at)
     values ($1, $2, $3, $4, 'proj', 'env', 'hash', '{}'::jsonb, now() - ($5 || ' days')::interval)`,
    [chatId, requestId, ORG, USER, String(ageDays)]
  );
}

async function count(table: string): Promise<number> {
  const rows = await raw(`select count(*)::int as n from trigger_dashboard_agent.${table}`);
  return Number((rows as unknown as { n: number }[])[0]!.n);
}

describe("the dashboard agent retention pass", () => {
  postgresTest(
    "drops turn evals, soft-deleted chats and finished watches past their windows",
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

      await createChat(db, { id: "chat_watches", organizationId: ORG, userId: USER });
      await seedTerminalWatch("watch_old", "chat_watches", 10);
      await seedTerminalWatch("watch_new", "chat_watches", 1);
      await seedSubmission("chat_watches", "req_old", 10);
      await seedSubmission("chat_watches", "req_new", 1);

      expect(await runDashboardAgentRetention(db)).toEqual({
        turnEvals: 1,
        chats: 1,
        watches: 1,
        watchSubmissions: 1,
      });

      expect(await count("chat_turn_evals")).toBe(1);
      const chats = await raw(`select id from trigger_dashboard_agent.chats order by id`);
      expect((chats as unknown as { id: string }[]).map((row) => row.id)).toEqual([
        "chat_evals",
        "chat_kept",
        "chat_watches",
      ]);
      const watches = await raw(`select id from trigger_dashboard_agent.watches order by id`);
      expect((watches as unknown as { id: string }[]).map((row) => row.id)).toEqual(["watch_new"]);
      const submissions = await raw(
        `select client_request_id from trigger_dashboard_agent.watch_submissions`
      );
      expect(
        (submissions as unknown as { client_request_id: string }[]).map(
          (row) => row.client_request_id
        )
      ).toEqual(["req_new"]);
    },
    60_000
  );

  postgresTest(
    "an active watch is never purged, however old it is",
    async ({ postgresContainer }) => {
      const db = await boot(postgresContainer.getConnectionUri());
      await createChat(db, { id: "chat_active", organizationId: ORG, userId: USER });
      await raw(
        `insert into trigger_dashboard_agent.watches
           (id, chat_id, identity, spec, organization_id, project_id, environment_id, user_id, expires_at, created_at)
         values ('watch_active', 'chat_active', 'ident', '{}'::jsonb, $1, 'proj', 'env', $2,
            now() + interval '1 day', now() - interval '30 days')`,
        [ORG, USER]
      );

      expect(await runDashboardAgentRetention(db)).toMatchObject({ watches: 0 });
      expect(await count("watches")).toBe(1);
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
      await seedTerminalWatch("watch_a", "chat_backlog", 10);
      await seedTerminalWatch("watch_b", "chat_backlog", 10);
      await seedSubmission("chat_backlog", "req_a", 10);
      await seedSubmission("chat_backlog", "req_b", 10);

      expect(await runDashboardAgentRetention(db, { limit: 1 })).toEqual({
        turnEvals: 5,
        chats: 0,
        watches: 2,
        watchSubmissions: 2,
      });
      expect(await count("chat_turn_evals")).toBe(0);
      expect(await count("watches")).toBe(0);
      expect(await count("watch_submissions")).toBe(0);
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
      await seedTerminalWatch("watch_after", "chat_failing", 10);

      await expect(
        runDashboardAgentRetention(db, {
          purgeChats: async () => {
            throw new Error("the chat purge failed");
          },
        })
      ).rejects.toThrow(/chats/);

      // The passes either side of the failing one still ran.
      expect(await count("chat_turn_evals")).toBe(0);
      expect(await count("watches")).toBe(0);
    },
    60_000
  );
});

describe("the maintenance database guard", () => {
  it("never falls back to the main database url", () => {
    expect(
      maintenanceConnectionString({ DATABASE_URL: "postgres://main" } as NodeJS.ProcessEnv)
    ).toBeUndefined();
  });

  it("uses the agent's own url when it is set", () => {
    expect(
      maintenanceConnectionString({
        DASHBOARD_AGENT_DATABASE_URL: "postgres://agent",
        DATABASE_URL: "postgres://main",
      } as NodeJS.ProcessEnv)
    ).toBe("postgres://agent");
  });
});
