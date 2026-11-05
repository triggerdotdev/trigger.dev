import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createChat, listChats } from "./queries.js";
import * as schema from "./schema.js";
import { applyDashboardAgentMigrations, type MigrationExecutor } from "./testing.js";

let container: StartedPostgreSqlContainer;
let sql: ReturnType<typeof postgres>;
let db: PostgresJsDatabase<typeof schema>;

beforeAll(async () => {
  container = await new PostgreSqlContainer("docker.io/postgres:14").start();
  sql = postgres(container.getConnectionUri(), { max: 5, prepare: false });
  db = drizzle(sql, { schema });
  const execute: MigrationExecutor = (statement) => sql.unsafe(statement).then(() => {});
  await applyDashboardAgentMigrations(execute);
}, 120_000);

afterAll(async () => {
  await sql?.end();
  await container?.stop();
});

describe("listChats withMessagesOnly", () => {
  // Mutation: ignoring withMessagesOnly lists empty chats.
  it("hides an empty chat", async () => {
    const viewer = { organizationId: "org_1", userId: "user_1" };
    await createChat(db, { id: "chat_empty", ...viewer });

    expect(await listChats(db, { ...viewer, withMessagesOnly: true })).toEqual([]);
    expect((await listChats(db, viewer)).map((chat) => chat.id)).toEqual(["chat_empty"]);
  });
});
