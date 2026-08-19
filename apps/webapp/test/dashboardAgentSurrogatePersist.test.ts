import {
  appendChatMessageOnce,
  createChat,
  createDashboardAgentDb,
  getChatMessages,
  persistMessages,
  persistTurn,
  type DashboardAgentDb,
  type DashboardAgentDbClient,
} from "@internal/dashboard-agent-db";
import { applyDashboardAgentMigrations } from "@internal/dashboard-agent-db/testing";
import { postgresTest } from "@internal/testcontainers";
import type { PrismaClient } from "@trigger.dev/database";
import { afterEach, describe, expect } from "vitest";

/**
 * jsonb rejects a lone UTF-16 surrogate, and a message body carries strings we never
 * authored — tool inputs, filenames, urls — from transports that don't pass the webapp
 * routes. `storeChatMessages` and `appendOneMessage` are where they have to be made storable.
 */

let agentDb: DashboardAgentDb;
let agentDbClient: DashboardAgentDbClient | undefined;

const ORG = "org_surrogate";
const USER = "user_surrogate";

afterEach(async () => {
  await agentDbClient?.close();
  agentDbClient = undefined;
});

async function boot(prisma: PrismaClient, connectionUri: string, chatId: string) {
  await applyDashboardAgentMigrations((statement) => prisma.$executeRawUnsafe(statement));
  agentDbClient = createDashboardAgentDb(connectionUri, { max: 4 });
  agentDb = agentDbClient.db;
  await createChat(agentDb, { id: chatId, organizationId: ORG, userId: USER });
}

async function transcript(chatId: string): Promise<unknown[]> {
  return getChatMessages(agentDb, { chatId, organizationId: ORG, userId: USER });
}

describe("a lone surrogate anywhere in a message body is storable", () => {
  postgresTest(
    "persists a tool input carrying a lone surrogate",
    async ({ prisma, postgresContainer }) => {
      const chatId = "chat_surrogate";
      await boot(prisma, postgresContainer.getConnectionUri(), chatId);

      await persistMessages(agentDb, {
        chatId,
        messages: [
          {
            id: "u1",
            role: "user",
            parts: [
              {
                type: "tool-search_docs",
                state: "input-available",
                toolCallId: "u1_call",
                input: { query: "how do i \ud83d", filename: "\udc00.png" },
              },
            ],
          },
        ],
      });

      const stored = (await transcript(chatId)) as {
        parts: { input: { query: string; filename: string } }[];
      }[];

      expect(stored).toHaveLength(1);
      expect(stored[0]!.parts[0]!.input.query).toBe("how do i �");
      expect(stored[0]!.parts[0]!.input.filename).toBe("�.png");
    },
    30_000
  );

  postgresTest(
    "finalises a tool output carrying a lone surrogate",
    async ({ prisma, postgresContainer }) => {
      const chatId = "chat_surrogate_turn";
      await boot(prisma, postgresContainer.getConnectionUri(), chatId);

      const call = (state: string, extra: Record<string, unknown>) => ({
        id: "a1",
        role: "assistant",
        parts: [{ type: "tool-search_docs", state, toolCallId: "a1_call", input: {}, ...extra }],
      });

      // Stored mid-flight by `onTurnStart`, then rewritten in place when the turn completes.
      await persistMessages(agentDb, { chatId, messages: [call("input-available", {})] });
      await persistTurn(agentDb, {
        chatId,
        messages: [call("output-available", { output: { text: "the page says \ud83d" } })],
        finalizeMessageIds: ["a1"],
        session: { publicAccessToken: "pat", lastEventId: "1", runId: "run" },
      });

      const stored = (await transcript(chatId)) as {
        parts: { state: string; output: { text: string } }[];
      }[];

      expect(stored).toHaveLength(1);
      expect(stored[0]!.parts[0]!.state).toBe("output-available");
      expect(stored[0]!.parts[0]!.output.text).toBe("the page says �");
    },
    30_000
  );

  postgresTest(
    "appends a wake message carrying a lone surrogate",
    async ({ prisma, postgresContainer }) => {
      const chatId = "chat_surrogate_append";
      await boot(prisma, postgresContainer.getConnectionUri(), chatId);

      const appended = await appendChatMessageOnce(agentDb, {
        chatId,
        userId: USER,
        organizationId: ORG,
        message: {
          id: "w1",
          role: "assistant",
          parts: [{ type: "text", text: "the queue \udc00 backed up" }],
        } as { id: string; role: string },
      });

      expect(appended).toBe(true);
      const stored = (await transcript(chatId)) as { parts: { text: string }[] }[];
      expect(stored[0]!.parts[0]!.text).toBe("the queue � backed up");
    },
    30_000
  );
});
