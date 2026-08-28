import {
  countChatsWithUnreadWork,
  createDashboardAgentDb,
  type DashboardAgentDb,
  type DashboardAgentDbClient,
} from "@internal/dashboard-agent-db";
import { postgresTest } from "@internal/testcontainers";
import type { PrismaClient } from "@trigger.dev/database";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

/**
 * `chats.last_read_at` is nullable and every reader treats NULL as unread, so without a
 * backfill the first load after rollout reports every pre-existing chat unread. Migrations
 * 0002 and 0003 backfill it; this replays them against a real Postgres to prove they do.
 *
 * 0003 is the one that reaches a database where 0002 already ran, which is every database
 * the column landed on before the backfill statement was appended to 0002.
 */

const DRIZZLE = path.resolve(__dirname, "../../../internal-packages/dashboard-agent-db/drizzle");

const MIGRATIONS = [
  "0000_magenta_lilandra.sql",
  "0001_slimy_living_tribunal.sql",
  "0002_watches_and_chat_messages.sql",
  "0003_backfill_chat_last_read_at.sql",
];

/** The statement under test, located by shape so removing it fails rather than silently passing. */
const BACKFILL = /^update\s+"trigger_dashboard_agent"\."chats"\s+set\s+"last_read_at"/i;

function statementsOf(file: string): string[] {
  return readFileSync(path.join(DRIZZLE, file), "utf8")
    .split("--> statement-breakpoint")
    .map((statement) =>
      statement
        .split("\n")
        .filter((line) => !line.trimStart().startsWith("--"))
        .join("\n")
        .trim()
    )
    .filter((statement) => statement.length > 0);
}

async function run(prisma: PrismaClient, statements: string[]) {
  for (const statement of statements) await prisma.$executeRawUnsafe(statement);
}

const SCOPE = { organizationId: "org_1", userId: "user_1" };

const CREATED_AT = new Date("2026-01-01T00:00:00.000Z");
const LAST_MESSAGE_AT = new Date("2026-02-01T00:00:00.000Z");
/** After the last message, so the chat is genuinely read and dropping the `where` moves it back. */
const ALREADY_READ_AT = new Date("2026-03-01T00:00:00.000Z");

/** Chats as they exist before 0002 runs — no `last_read_at` column yet. */
async function seedPreExistingChats(prisma: PrismaClient) {
  for (const [id, lastMessageAt] of [
    ["chat_with_messages", LAST_MESSAGE_AT],
    ["chat_never_messaged", null],
    ["chat_already_read", LAST_MESSAGE_AT],
  ] as const) {
    await prisma.$executeRawUnsafe(
      `insert into "trigger_dashboard_agent"."chats"
         ("id", "organization_id", "user_id", "created_at", "updated_at", "last_message_at")
       values ($1, $2, $3, $4, $4, $5)`,
      id,
      SCOPE.organizationId,
      SCOPE.userId,
      CREATED_AT,
      lastMessageAt
    );
  }
}

async function readLastReadAt(prisma: PrismaClient): Promise<Record<string, Date | null>> {
  const rows = await prisma.$queryRawUnsafe<Array<{ id: string; last_read_at: Date | null }>>(
    `select "id", "last_read_at" from "trigger_dashboard_agent"."chats" order by "id"`
  );
  return Object.fromEntries(rows.map((row) => [row.id, row.last_read_at]));
}

describe("the replayed migration list", () => {
  it("is the first migrations on disk, so a renamed or inserted one fails here", () => {
    const onDisk = readdirSync(DRIZZLE)
      .filter((file) => file.endsWith(".sql"))
      .sort();

    expect(onDisk.slice(0, MIGRATIONS.length)).toEqual(MIGRATIONS);
  });
});

let agentDbClient: DashboardAgentDbClient | undefined;

afterEach(async () => {
  await agentDbClient?.close();
  agentDbClient = undefined;
});

describe("the last_read_at backfill in migration 0002", () => {
  postgresTest(
    "starts pre-existing chats read, and does not overwrite a chat already read",
    async ({ prisma, postgresContainer }) => {
      await run(prisma, statementsOf(MIGRATIONS[0]!));
      await run(prisma, statementsOf(MIGRATIONS[1]!));

      const statements = statementsOf(MIGRATIONS[2]!);
      const backfillAt = statements.findIndex((statement) => BACKFILL.test(statement));
      expect(backfillAt, "0002 contains no last_read_at backfill statement").toBeGreaterThan(-1);

      // Everything up to the backfill: the column exists, the chats predate it.
      await run(prisma, statements.slice(0, backfillAt));
      await seedPreExistingChats(prisma);
      // A deploy that rolled the column out ahead of the backfill could already have a value.
      await prisma.$executeRawUnsafe(
        `update "trigger_dashboard_agent"."chats" set "last_read_at" = $1 where "id" = 'chat_already_read'`,
        ALREADY_READ_AT
      );
      expect(await readLastReadAt(prisma)).toEqual({
        chat_with_messages: null,
        chat_never_messaged: null,
        chat_already_read: ALREADY_READ_AT,
      });

      await run(prisma, statements.slice(backfillAt));

      expect(await readLastReadAt(prisma)).toEqual({
        // Read as of its last message: a later message still lights the dot.
        chat_with_messages: LAST_MESSAGE_AT,
        // Nothing was ever said in it, so it is read as of the moment it existed.
        chat_never_messaged: CREATED_AT,
        // Already read; the backfill must not move it back or forward.
        chat_already_read: ALREADY_READ_AT,
      });

      agentDbClient = createDashboardAgentDb(postgresContainer.getConnectionUri(), { max: 2 });
      const agentDb: DashboardAgentDb = agentDbClient.db;

      // The user-visible claim: the launcher dot is dark on the first load after rollout.
      expect(await countChatsWithUnreadWork(agentDb, SCOPE)).toBe(0);

      // And a positive control, so a backfill that marked everything read forever would fail.
      await prisma.$executeRawUnsafe(
        `update "trigger_dashboard_agent"."chats" set "last_message_at" = now() where "id" = 'chat_never_messaged'`
      );
      expect(await countChatsWithUnreadWork(agentDb, SCOPE)).toBe(1);
    }
  );
});

describe("the last_read_at catch-up in migration 0003", () => {
  postgresTest(
    "starts pre-existing chats read on a database that already ran 0002",
    async ({ prisma, postgresContainer }) => {
      await run(prisma, statementsOf(MIGRATIONS[0]!));
      await run(prisma, statementsOf(MIGRATIONS[1]!));

      // 0002 as it was already applied everywhere: the column, without the backfill that
      // was appended to it later. Re-running 0002 there is impossible — its hash is spent.
      const applied = statementsOf(MIGRATIONS[2]!).filter((statement) => !BACKFILL.test(statement));
      await run(prisma, applied);
      await seedPreExistingChats(prisma);
      await prisma.$executeRawUnsafe(
        `update "trigger_dashboard_agent"."chats" set "last_read_at" = $1 where "id" = 'chat_already_read'`,
        ALREADY_READ_AT
      );

      agentDbClient = createDashboardAgentDb(postgresContainer.getConnectionUri(), { max: 2 });
      const agentDb: DashboardAgentDb = agentDbClient.db;

      // The bug 0003 exists for: every chat that predates the column reads as unread.
      expect(await countChatsWithUnreadWork(agentDb, SCOPE)).toBe(1);

      const catchUp = statementsOf(MIGRATIONS[3]!);
      expect(catchUp.some((statement) => BACKFILL.test(statement))).toBe(true);
      await run(prisma, catchUp);

      expect(await readLastReadAt(prisma)).toEqual({
        chat_with_messages: LAST_MESSAGE_AT,
        chat_never_messaged: CREATED_AT,
        chat_already_read: ALREADY_READ_AT,
      });
      expect(await countChatsWithUnreadWork(agentDb, SCOPE)).toBe(0);

      // Still a dot for work that lands after the catch-up.
      await prisma.$executeRawUnsafe(
        `update "trigger_dashboard_agent"."chats" set "last_message_at" = now() where "id" = 'chat_with_messages'`
      );
      expect(await countChatsWithUnreadWork(agentDb, SCOPE)).toBe(1);
    }
  );
});
