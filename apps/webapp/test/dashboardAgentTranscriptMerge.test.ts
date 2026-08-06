import {
  appendChatMessageOnceByChatId,
  createChat,
  createDashboardAgentDb,
  getChatMessages,
  getInvestigation,
  investigationSettlementMessageId,
  persistMessages,
  persistTurn,
  settleInvestigationAndCloseCard,
  upsertInvestigationRevision,
  type DashboardAgentDb,
  type DashboardAgentDbClient,
} from "@internal/dashboard-agent-db";
import {
  investigationStateSchema,
  type InvestigationState,
} from "@internal/dashboard-agent-contracts";
import { postgresTest } from "@internal/testcontainers";
import type { PrismaClient } from "@trigger.dev/database";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect } from "vitest";

/**
 * The snapshot writes, against a real row.
 *
 * `persistTurn` and `persistMessages` both store a whole `messages` array, and the
 * array they store was read at the start of a turn. Anything another process appended
 * in between — a wake, a watch consent record, the terminal card of a settled
 * investigation — is only still there if the write merges rather than replaces.
 */

let agentDb: DashboardAgentDb;
let agentDbClient: DashboardAgentDbClient | undefined;

/** Replays every migration in order, so a new migration can't leave the suite on a stale schema. */
async function applyAgentSchema(prisma: PrismaClient) {
  const folder = path.resolve(__dirname, "../../../internal-packages/dashboard-agent-db/drizzle");
  for (const name of readdirSync(folder)
    .filter((file) => file.endsWith(".sql"))
    .sort()) {
    const sql = readFileSync(path.join(folder, name), "utf8");
    for (const statement of sql.split("--> statement-breakpoint")) {
      const trimmed = statement.trim();
      if (trimmed.length > 0) await prisma.$executeRawUnsafe(trimmed);
    }
  }
}

const ORG_ID = "org_merge";
const USER_ID = "user_merge";
const PROJECT_REF = "proj_merge";
const ENV_REF = "env_merge";

async function boot(prisma: PrismaClient, connectionUri: string, chatId: string) {
  await applyAgentSchema(prisma);
  agentDbClient = createDashboardAgentDb(connectionUri, { max: 2 });
  agentDb = agentDbClient.db;
  await createChat(agentDb, { id: chatId, organizationId: ORG_ID, userId: USER_ID });
}

afterEach(async () => {
  await agentDbClient?.close();
  agentDbClient = undefined;
});

function textMessage(id: string) {
  return { id, role: "assistant" as const, parts: [{ type: "text", text: id }] };
}

async function transcript(chatId: string): Promise<{ id: string }[]> {
  return (await getChatMessages(agentDb, {
    chatId,
    userId: USER_ID,
    organizationId: ORG_ID,
  })) as { id: string }[];
}

function openState(): InvestigationState {
  return investigationStateSchema.parse({
    outcome: "in_progress",
    severity: "warn",
    confidence: "medium",
    title: "send-order-receipt keeps failing",
    headline: "Checking whether the failures share a payload.",
    progress: "Reading the run's spans",
    hypotheses: [],
    evidence: [],
  });
}

describe("the dashboard agent's snapshot writes", () => {
  postgresTest(
    "persistTurn keeps a message appended after the turn's snapshot was taken",
    async ({ prisma, postgresContainer }) => {
      const chatId = "chat_merge_turn";
      await boot(prisma, postgresContainer.getConnectionUri(), chatId);

      // The transcript the turn started from.
      const snapshot = [textMessage("u1"), textMessage("a1")];
      await persistMessages(agentDb, { chatId, messages: snapshot });

      // Another process — a wake delivery — appends while the turn is running.
      expect(
        await appendChatMessageOnceByChatId(agentDb, {
          chatId,
          message: textMessage("wake:watch_1:fired"),
        })
      ).toBe(true);

      // The turn ends and stores its own snapshot plus what it produced.
      await persistTurn(agentDb, {
        chatId,
        messages: [...snapshot, textMessage("a2")],
        session: { publicAccessToken: "pat_merge", lastEventId: "1", runId: "run_merge" },
      });

      // The turn's order is kept and the wake is still in the conversation.
      expect((await transcript(chatId)).map((message) => message.id)).toEqual([
        "u1",
        "a1",
        "a2",
        "wake:watch_1:fired",
      ]);
    },
    30_000
  );

  postgresTest(
    "persistMessages keeps a message appended after its snapshot was taken",
    async ({ prisma, postgresContainer }) => {
      const chatId = "chat_merge_messages";
      await boot(prisma, postgresContainer.getConnectionUri(), chatId);

      const snapshot = [textMessage("u1")];
      await persistMessages(agentDb, { chatId, messages: snapshot });
      await appendChatMessageOnceByChatId(agentDb, {
        chatId,
        message: textMessage("watch-request:watch_1"),
      });

      // The next turn starts from the stale snapshot the client carried.
      await persistMessages(agentDb, { chatId, messages: [...snapshot, textMessage("u2")] });

      expect((await transcript(chatId)).map((message) => message.id)).toEqual([
        "u1",
        "u2",
        "watch-request:watch_1",
      ]);
    }
  );

  /**
   * The worst case. The sweep settles a stale investigation and appends its terminal
   * card in one transaction; if the next `persistTurn` then replaces the transcript,
   * the card is gone for good — the row is already terminal, so the sweep never selects
   * it again and the panel is back to "Working…" for ever.
   */
  postgresTest(
    "a settled investigation's terminal card survives the next persistTurn",
    async ({ prisma, postgresContainer }) => {
      const chatId = "chat_merge_settled";
      await boot(prisma, postgresContainer.getConnectionUri(), chatId);

      const snapshot = [textMessage("u1")];
      await persistMessages(agentDb, { chatId, messages: snapshot });

      const created = await upsertInvestigationRevision(agentDb, {
        chatId,
        projectRef: PROJECT_REF,
        environmentRef: ENV_REF,
        state: openState(),
      });
      if (!created.ok) throw new Error("the fixture investigation wasn't created");

      const closed = await settleInvestigationAndCloseCard(agentDb, {
        id: created.id,
        chatId,
        note: "Stopped without a verdict.",
      });
      expect(closed?.closed).toBe(true);
      const cardId = investigationSettlementMessageId(created.id, 1);

      await persistTurn(agentDb, {
        chatId,
        messages: [...snapshot, textMessage("a1")],
        session: { publicAccessToken: "pat_merge" },
      });

      expect((await transcript(chatId)).map((message) => message.id)).toContain(cardId);
      // And the row it belongs to is still terminal, so nothing will re-open it.
      const row = await getInvestigation(agentDb, { id: created.id });
      expect(investigationStateSchema.parse(row?.state).outcome).toBe("inconclusive");
    },
    30_000
  );

  postgresTest(
    "a message the snapshot already has is never stored twice",
    async ({ prisma, postgresContainer }) => {
      const chatId = "chat_merge_dedupe";
      await boot(prisma, postgresContainer.getConnectionUri(), chatId);

      const snapshot = [textMessage("u1"), textMessage("a1")];
      await persistMessages(agentDb, { chatId, messages: snapshot });
      // The client's snapshot carries the host-appended message too, which is the
      // ordinary case once the panel has reloaded.
      await appendChatMessageOnceByChatId(agentDb, { chatId, message: textMessage("wake:w1") });

      await persistTurn(agentDb, {
        chatId,
        messages: [...snapshot, textMessage("wake:w1"), textMessage("a2")],
        session: { publicAccessToken: "pat_merge" },
      });

      expect((await transcript(chatId)).map((message) => message.id)).toEqual([
        "u1",
        "a1",
        "wake:w1",
        "a2",
      ]);
    }
  );
});
