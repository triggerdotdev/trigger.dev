import {
  createChat,
  createDashboardAgentDb,
  persistMessages,
  type DashboardAgentDb,
  type DashboardAgentDbClient,
} from "@internal/dashboard-agent-db";
import { applyDashboardAgentMigrations } from "@internal/dashboard-agent-db/testing";
import { postgresTest } from "@internal/testcontainers";
import type { PrismaClient } from "@trigger.dev/database";
import { afterEach, describe, expect, test } from "vitest";
import { wellFormMessageText } from "~/services/dashboardAgentMessageText.server";

/** A lone surrogate in a message: normalized at ingest, and again by the store before jsonb. */

let agentDb: DashboardAgentDb;
let agentDbClient: DashboardAgentDbClient | undefined;

const ORG_ID = "org_surrogate";
const USER_ID = "user_surrogate";
const CHAT_ID = "chat_surrogate";

/** The high half of an emoji whose low half was lost. */
const RAW_TEXT = "why did this run fail \ud83d";
const NORMALIZED_TEXT = "why did this run fail \ufffd";

function userMessage(id: string) {
  return { id, role: "user" as const, parts: [{ type: "text", text: RAW_TEXT }] };
}

async function boot(prisma: PrismaClient, connectionUri: string) {
  await applyDashboardAgentMigrations((statement) => prisma.$executeRawUnsafe(statement));
  agentDbClient = createDashboardAgentDb(connectionUri, { max: 4 });
  agentDb = agentDbClient.db;
  await createChat(agentDb, { id: CHAT_ID, organizationId: ORG_ID, userId: USER_ID });
}

afterEach(async () => {
  await agentDbClient?.close();
  agentDbClient = undefined;
});

async function storedText(prisma: PrismaClient, messageId: string): Promise<string> {
  const rows = await prisma.$queryRawUnsafe<{ text: string }[]>(
    `select message -> 'parts' -> 0 ->> 'text' as text
     from trigger_dashboard_agent.chat_messages
     where chat_id = $1 and message_id = $2`,
    CHAT_ID,
    messageId
  );
  return rows[0]!.text;
}

describe("a lone surrogate in a message", () => {
  postgresTest(
    "reaches the store raw and still persists, normalized",
    async ({ prisma, postgresContainer }) => {
      await boot(prisma, postgresContainer.getConnectionUri());

      await persistMessages(agentDb, { chatId: CHAT_ID, messages: [userMessage("raw")] });

      expect(await storedText(prisma, "raw")).toBe(NORMALIZED_TEXT);
    },
    30_000
  );

  // The store normalizes too, so only the parts themselves show what ingest did \u2014 and it is
  // the parts the model is handed.
  test("is gone from the parts ingest hands on", () => {
    const message = userMessage("ingest");

    wellFormMessageText(message.parts);

    expect(message.parts[0]!.text).toBe(NORMALIZED_TEXT);
  });
});
