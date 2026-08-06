import {
  appendChatMessageOnceByChatId,
  countUserMessages,
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
 * The message store's idempotency invariants, against a real table.
 *
 * The transcript used to be one JSONB array rewritten on every turn, so a message
 * another process appended mid-turn survived only if the write merged rather than
 * replaced. It is now one row per message: identity is `(chat_id, message_id)` and order
 * is a unique `position`, both enforced by the database rather than by application code.
 */

let agentDb: DashboardAgentDb;
let agentDbClient: DashboardAgentDbClient | undefined;

const MIGRATIONS = path.resolve(__dirname, "../../../internal-packages/dashboard-agent-db/drizzle");

/** Replays every migration in order, so a new migration can't leave the suite on a stale schema. */
async function applyAgentSchema(prisma: PrismaClient) {
  for (const name of readdirSync(MIGRATIONS)
    .filter((file) => file.endsWith(".sql"))
    .sort()) {
    const sql = readFileSync(path.join(MIGRATIONS, name), "utf8");
    for (const statement of sql.split("--> statement-breakpoint")) {
      const trimmed = statement.trim();
      if (trimmed.length > 0) await prisma.$executeRawUnsafe(trimmed);
    }
  }
}

const ORG_ID = "org_store";
const USER_ID = "user_store";
const PROJECT_REF = "proj_store";
const ENV_REF = "env_store";

async function boot(prisma: PrismaClient, connectionUri: string, chatId?: string) {
  await applyAgentSchema(prisma);
  agentDbClient = createDashboardAgentDb(connectionUri, { max: 4 });
  agentDb = agentDbClient.db;
  if (chatId) await createChat(agentDb, { id: chatId, organizationId: ORG_ID, userId: USER_ID });
}

afterEach(async () => {
  await agentDbClient?.close();
  agentDbClient = undefined;
});

function textMessage(id: string, text = id) {
  return { id, role: "assistant" as const, parts: [{ type: "text", text }] };
}

async function transcript(chatId: string): Promise<{ id: string }[]> {
  return (await getChatMessages(agentDb, {
    chatId,
    userId: USER_ID,
    organizationId: ORG_ID,
  })) as { id: string }[];
}

type StoredRow = { message_id: string; position: number; message: unknown; created_at: Date };

/** The stored rows themselves, which is where identity and position are observable. */
async function rows(prisma: PrismaClient, chatId: string): Promise<StoredRow[]> {
  return prisma.$queryRawUnsafe<StoredRow[]>(
    `select message_id, position, message, created_at
     from trigger_dashboard_agent.chat_messages
     where chat_id = $1
     order by position`,
    chatId
  );
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

describe("invariant 1: a repeated message id creates no row and keeps its position", () => {
  postgresTest(
    "a redelivered append writes nothing at all",
    async ({ prisma, postgresContainer }) => {
      const chatId = "chat_repeat_append";
      await boot(prisma, postgresContainer.getConnectionUri(), chatId);

      await persistMessages(agentDb, { chatId, messages: [textMessage("u1")] });
      expect(
        await appendChatMessageOnceByChatId(agentDb, { chatId, message: textMessage("wake:w1") })
      ).toBe(true);

      const before = await rows(prisma, chatId);

      // The same durable event, redelivered.
      expect(
        await appendChatMessageOnceByChatId(agentDb, { chatId, message: textMessage("wake:w1") })
      ).toBe(false);

      expect(await rows(prisma, chatId)).toEqual(before);
    },
    30_000
  );

  postgresTest(
    "a message the turn's snapshot already holds keeps its first position",
    async ({ prisma, postgresContainer }) => {
      const chatId = "chat_repeat_snapshot";
      await boot(prisma, postgresContainer.getConnectionUri(), chatId);

      const snapshot = [textMessage("u1"), textMessage("a1")];
      await persistMessages(agentDb, { chatId, messages: snapshot });
      const before = await rows(prisma, chatId);

      // The next turn re-sends the whole snapshot plus what it produced.
      await persistMessages(agentDb, { chatId, messages: [...snapshot, textMessage("u2")] });

      const after = await rows(prisma, chatId);
      expect(after).toHaveLength(3);
      expect(after.slice(0, 2)).toEqual(before);
      expect(after[2]!.message_id).toBe("u2");
    },
    30_000
  );
});

describe("invariant 2: concurrent different messages get distinct positions", () => {
  postgresTest(
    "eight genuinely concurrent appends land eight rows in eight positions",
    async ({ prisma, postgresContainer }) => {
      const chatId = "chat_concurrent";
      await boot(prisma, postgresContainer.getConnectionUri(), chatId);

      const ids = Array.from({ length: 8 }, (_, i) => `wake:w${i}`);
      const results = await Promise.all(
        ids.map((id) =>
          appendChatMessageOnceByChatId(agentDb, { chatId, message: textMessage(id) })
        )
      );

      expect(results.every(Boolean)).toBe(true);
      const stored = await rows(prisma, chatId);
      expect(stored).toHaveLength(8);
      expect(new Set(stored.map((row) => row.position)).size).toBe(8);
      expect(new Set(stored.map((row) => row.message_id))).toEqual(new Set(ids));
    },
    30_000
  );

  postgresTest(
    "concurrent batches reserve ranges that don't overlap",
    async ({ prisma, postgresContainer }) => {
      const chatId = "chat_concurrent_batches";
      await boot(prisma, postgresContainer.getConnectionUri(), chatId);

      // Four turns writing three messages each, all at once. The ranges have to be
      // disjoint: if two batches read the same allocator value they collide on position.
      const batches = Array.from({ length: 4 }, (_, batch) =>
        Array.from({ length: 3 }, (_, index) => textMessage(`b${batch}m${index}`))
      );
      await Promise.all(batches.map((messages) => persistMessages(agentDb, { chatId, messages })));

      const stored = await rows(prisma, chatId);
      expect(stored).toHaveLength(12);
      expect(new Set(stored.map((row) => row.position)).size).toBe(12);
      // And each batch's own three messages stayed together and in order.
      for (const [batch, messages] of batches.entries()) {
        const positions = messages.map(
          (message) => stored.find((row) => row.message_id === message.id)!.position
        );
        expect(positions, `batch ${batch}`).toEqual([
          positions[0]!,
          positions[0]! + 1,
          positions[0]! + 2,
        ]);
      }
    },
    30_000
  );

  postgresTest(
    "the database is what forbids two messages sharing a position",
    async ({ prisma, postgresContainer }) => {
      const chatId = "chat_position_unique";
      await boot(prisma, postgresContainer.getConnectionUri(), chatId);

      await persistMessages(agentDb, { chatId, messages: [textMessage("u1")] });
      const taken = (await rows(prisma, chatId))[0]!.position;

      // Nothing in the query layer can be relied on here: this writes straight past it.
      await expect(
        prisma.$executeRawUnsafe(
          `insert into trigger_dashboard_agent.chat_messages
             (chat_id, message_id, position, role, message)
           values ($1, $2, $3, 'assistant', '{}'::jsonb)`,
          chatId,
          "a-different-message",
          taken
        )
        // 23505 is unique_violation, and the key it names is the position constraint's.
      ).rejects.toThrow(/23505[\s\S]*Key \(chat_id, .?position.?\)/);
    },
    30_000
  );
});

describe("invariant 3: a controlled update changes the body and nothing else", () => {
  postgresTest(
    "finalising a message keeps its id, its position and its row",
    async ({ prisma, postgresContainer }) => {
      const chatId = "chat_finalise";
      await boot(prisma, postgresContainer.getConnectionUri(), chatId);

      await persistMessages(agentDb, {
        chatId,
        messages: [textMessage("u1"), textMessage("a1", "still working")],
      });
      const before = await rows(prisma, chatId);

      await persistMessages(agentDb, {
        chatId,
        messages: [textMessage("u1"), textMessage("a1", "here is the answer")],
      });

      const after = await rows(prisma, chatId);
      expect(after).toHaveLength(2);
      expect(after.map((row) => [row.message_id, row.position])).toEqual(
        before.map((row) => [row.message_id, row.position])
      );
      // Only the one message that changed changed.
      expect(after[0]!.message).toEqual(before[0]!.message);
      expect(after[1]!.message).toMatchObject({ parts: [{ text: "here is the answer" }] });
    },
    30_000
  );
});

describe("a write can no longer lose a message another process appended", () => {
  postgresTest(
    "a mid-turn append survives the turn's write, and lands before the turn's later messages",
    async ({ prisma, postgresContainer }) => {
      const chatId = "chat_midturn";
      await boot(prisma, postgresContainer.getConnectionUri(), chatId);

      // The transcript the turn started from.
      const snapshot = [textMessage("u1"), textMessage("a1")];
      await persistMessages(agentDb, { chatId, messages: snapshot });

      // Another process — a wake delivery — appends while the turn is running.
      await appendChatMessageOnceByChatId(agentDb, {
        chatId,
        message: textMessage("wake:watch_1:fired"),
      });

      // The turn ends and writes its own snapshot plus what it produced.
      await persistTurn(agentDb, {
        chatId,
        messages: [...snapshot, textMessage("a2")],
        session: { publicAccessToken: "pat_store", lastEventId: "1", runId: "run_store" },
      });

      // The wake is still there, and sits where it happened: after the turn's snapshot,
      // before the reply the turn went on to produce.
      expect((await transcript(chatId)).map((message) => message.id)).toEqual([
        "u1",
        "a1",
        "wake:watch_1:fired",
        "a2",
      ]);
    },
    30_000
  );

  /**
   * The worst case. The sweep settles a stale investigation and appends its terminal
   * card in one transaction; if the next write then replaced the transcript, the card
   * would be gone for good — the row is already terminal, so the sweep never selects it
   * again and the panel is back to "Working…" for ever.
   */
  postgresTest(
    "a settled investigation's terminal card survives the next persistTurn",
    async ({ prisma, postgresContainer }) => {
      const chatId = "chat_settled";
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
        session: { publicAccessToken: "pat_store" },
      });

      expect((await transcript(chatId)).map((message) => message.id)).toContain(cardId);
      // And the row it belongs to is still terminal, so nothing will re-open it.
      const row = await getInvestigation(agentDb, { id: created.id });
      expect(investigationStateSchema.parse(row?.state).outcome).toBe("inconclusive");
    },
    30_000
  );
});

describe("countUserMessages", () => {
  postgresTest(
    "counts a user's own messages, and only those",
    async ({ prisma, postgresContainer }) => {
      await boot(prisma, postgresContainer.getConnectionUri());
      await createChat(agentDb, { id: "chat_a", organizationId: ORG_ID, userId: USER_ID });
      await createChat(agentDb, { id: "chat_b", organizationId: ORG_ID, userId: USER_ID });
      await createChat(agentDb, { id: "chat_gone", organizationId: ORG_ID, userId: USER_ID });
      await createChat(agentDb, { id: "chat_other", organizationId: ORG_ID, userId: "user_other" });

      const userMessage = (id: string) => ({
        id,
        role: "user" as const,
        parts: [{ type: "text", text: id }],
      });

      await persistMessages(agentDb, {
        chatId: "chat_a",
        // A watch's consent record is a user message but not a turn the user spent.
        messages: [userMessage("u1"), textMessage("a1"), userMessage("watch-request:watch_1")],
      });
      await persistMessages(agentDb, { chatId: "chat_b", messages: [userMessage("u2")] });
      await persistMessages(agentDb, { chatId: "chat_gone", messages: [userMessage("u3")] });
      await persistMessages(agentDb, { chatId: "chat_other", messages: [userMessage("u4")] });
      await prisma.$executeRawUnsafe(
        `update trigger_dashboard_agent.chats set deleted_at = now() where id = 'chat_gone'`
      );

      const scope = { organizationId: ORG_ID, userId: USER_ID };
      expect(await countUserMessages(agentDb, scope)).toBe(2);
      expect(await countUserMessages(agentDb, { ...scope, excludeChatId: "chat_b" })).toBe(1);
      expect(
        await countUserMessages(agentDb, { organizationId: "org_elsewhere", userId: USER_ID })
      ).toBe(0);
    },
    30_000
  );
});
