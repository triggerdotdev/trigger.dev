import {
  appendChatMessageOnceByChatId,
  countChatsWithUnreadWork,
  countUserMessages,
  createChat,
  createDashboardAgentDb,
  finalizeChatMessage,
  getChatMessages,
  getInvestigation,
  investigationSettlementMessageId,
  persistMessages,
  seedInvestigation,
  persistTurn,
  settleInvestigationAndCloseCard,
  upsertInvestigationRevision,
  watchInvestigationId,
  type DashboardAgentDb,
  type DashboardAgentDbClient,
} from "@internal/dashboard-agent-db";
import { applyDashboardAgentMigrations } from "@internal/dashboard-agent-db/testing";
import {
  investigationStateSchema,
  type InvestigationState,
} from "@internal/dashboard-agent-contracts";
import { postgresTest } from "@internal/testcontainers";
import type { PrismaClient } from "@trigger.dev/database";
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

const ORG_ID = "org_store";
const USER_ID = "user_store";
const PROJECT_REF = "proj_store";
const ENV_REF = "env_store";

async function boot(prisma: PrismaClient, connectionUri: string, chatId?: string) {
  await applyDashboardAgentMigrations((statement) => prisma.$executeRawUnsafe(statement));
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

// Compile-time: the insert reads `role` off the body and throws without one, so a
// message that satisfies the signature must never be able to lack it.
const _roleIsRequired = (message: { id: string }) =>
  // @ts-expect-error a message with no role is not appendable
  appendChatMessageOnceByChatId(agentDb, { chatId: "chat_x", message });

function toolMessage(id: string, state: "input-available" | "output-available") {
  return {
    id,
    role: "assistant" as const,
    parts: [{ type: "tool-get_query_schema", state, toolCallId: `${id}_call`, input: {} }],
  };
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

/** The position allocator itself: what a wasted reservation is visible in. */
async function nextPosition(prisma: PrismaClient, chatId: string): Promise<number> {
  const rows = await prisma.$queryRawUnsafe<{ next_message_position: number }[]>(
    `select next_message_position from trigger_dashboard_agent.chats where id = $1`,
    chatId
  );
  return rows[0]!.next_message_position;
}

async function chatStamps(
  prisma: PrismaClient,
  chatId: string
): Promise<{ last_message_at: Date | null; updated_at: Date }[]> {
  return prisma.$queryRawUnsafe(
    `select last_message_at, updated_at from trigger_dashboard_agent.chats where id = $1`,
    chatId
  );
}

/** The structural column, which the JSONB payload must never be able to contradict. */
async function roleOf(prisma: PrismaClient, chatId: string, messageId: string): Promise<string> {
  const rows = await prisma.$queryRawUnsafe<{ role: string }[]>(
    `select role from trigger_dashboard_agent.chat_messages where chat_id = $1 and message_id = $2`,
    chatId,
    messageId
  );
  return rows[0]!.role;
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

describe("invariant 3: an ordinary transcript write can never change a stored message", () => {
  postgresTest(
    "a differing body under an existing id leaves the durable row exactly as it was",
    async ({ prisma, postgresContainer }) => {
      const chatId = "chat_no_implicit_update";
      await boot(prisma, postgresContainer.getConnectionUri(), chatId);

      await persistMessages(agentDb, { chatId, messages: [textMessage("u1")] });
      // A durable event: the wake that actually fired.
      await appendChatMessageOnceByChatId(agentDb, {
        chatId,
        message: textMessage("wake:watch_1:fired", "The watch on send-order-receipt resolved."),
      });
      const before = await rows(prisma, chatId);

      // A stale snapshot carrying the same id with a different body. `persistMessages` is
      // not a finalisation, so it must not be able to rewrite it.
      await persistMessages(agentDb, {
        chatId,
        messages: [textMessage("u1"), textMessage("wake:watch_1:fired", "something else entirely")],
      });

      expect(await rows(prisma, chatId)).toEqual(before);
    },
    30_000
  );

  postgresTest(
    "a completing turn finalises the body it stored mid-flight",
    async ({ prisma, postgresContainer }) => {
      // `onTurnStart` stores the turn's messages before the model has finished, so the
      // transcript first holds a tool call with no result. The completed turn arrives
      // under the same message id, and what the user was shown has to win.
      const chatId = "chat_turn_finalises_own_message";
      await boot(prisma, postgresContainer.getConnectionUri(), chatId);

      await persistMessages(agentDb, { chatId, messages: [toolMessage("a1", "input-available")] });
      const before = await rows(prisma, chatId);

      await persistTurn(agentDb, {
        chatId,
        messages: [toolMessage("a1", "output-available")],
        finalizeMessageIds: ["a1"],
        session: { publicAccessToken: "pat_store" },
      });

      const after = await rows(prisma, chatId);
      expect(after).toHaveLength(1);
      expect(after[0]!.position).toBe(before[0]!.position);
      expect(after[0]!.message).toMatchObject({
        parts: [{ state: "output-available" }],
      });
      // A finalisation is not an append: no slot is consumed.
      expect(await nextPosition(prisma, chatId)).toBe(2);
    },
    30_000
  );

  postgresTest(
    "a batch carrying the same id twice is refused rather than silently picking one",
    async ({ prisma, postgresContainer }) => {
      const chatId = "chat_dup_in_batch";
      await boot(prisma, postgresContainer.getConnectionUri(), chatId);

      await expect(
        persistMessages(agentDb, {
          chatId,
          messages: [textMessage("a1", "first"), textMessage("a1", "second")],
        })
      ).rejects.toThrow(/message id a1 twice in one batch/);

      // And nothing landed: the throw is before any reservation.
      expect(await rows(prisma, chatId)).toHaveLength(0);
      expect(await nextPosition(prisma, chatId)).toBe(1);
    },
    30_000
  );

  postgresTest(
    "a message with no id or no role is refused by name, not by a NOT NULL violation",
    async ({ prisma, postgresContainer }) => {
      const chatId = "chat_malformed";
      await boot(prisma, postgresContainer.getConnectionUri(), chatId);

      // The shape, never the values: a malformed message can carry user text.
      await expect(
        persistMessages(agentDb, {
          chatId,
          messages: [
            { role: "user", parts: [{ type: "text", text: "card 4242 for alice@x.test" }] },
          ],
        })
      ).rejects.toThrow(
        /Chat chat_malformed was handed a message with no id: object with keys: role, parts$/
      );

      await expect(
        persistMessages(agentDb, { chatId, messages: [{ id: "a1", parts: [] }] })
      ).rejects.toThrow(
        /Chat chat_malformed was handed a message with no role: object with keys: id, parts$/
      );

      const leaked = await persistMessages(agentDb, {
        chatId,
        messages: [{ role: "user", parts: [{ type: "text", text: "alice@x.test" }] }],
      }).catch((error: Error) => error.message);
      expect(leaked).not.toContain("alice@x.test");
      expect(leaked).not.toContain("4242");
    },
    30_000
  );
});

describe("invariant 4: a controlled finalisation changes the body and nothing else", () => {
  postgresTest(
    "finalising a message keeps its id, its position and its role",
    async ({ prisma, postgresContainer }) => {
      const chatId = "chat_finalise";
      await boot(prisma, postgresContainer.getConnectionUri(), chatId);

      await persistMessages(agentDb, {
        chatId,
        messages: [textMessage("u1"), textMessage("a1", "still working")],
      });
      const before = await rows(prisma, chatId);

      expect(
        await finalizeChatMessage(agentDb, {
          chatId,
          messageId: "a1",
          expectedRole: "assistant",
          message: textMessage("a1", "here is the answer"),
        })
      ).toBe(true);

      const after = await rows(prisma, chatId);
      expect(after).toHaveLength(2);
      expect(after.map((row) => [row.message_id, row.position])).toEqual(
        before.map((row) => [row.message_id, row.position])
      );
      // Only the one message named changed.
      expect(after[0]!.message).toEqual(before[0]!.message);
      expect(after[1]!.message).toMatchObject({ parts: [{ text: "here is the answer" }] });
      expect(await roleOf(prisma, chatId, "a1")).toBe("assistant");
    },
    30_000
  );

  postgresTest(
    "a finalisation aimed at the wrong role writes nothing",
    async ({ prisma, postgresContainer }) => {
      const chatId = "chat_finalise_role";
      await boot(prisma, postgresContainer.getConnectionUri(), chatId);

      await persistMessages(agentDb, { chatId, messages: [textMessage("a1", "still working")] });
      const before = await rows(prisma, chatId);

      // The stored row is an assistant message, so a user finalisation is not its own.
      expect(
        await finalizeChatMessage(agentDb, {
          chatId,
          messageId: "a1",
          expectedRole: "user",
          message: { id: "a1", role: "user", parts: [{ type: "text", text: "hijacked" }] },
        })
      ).toBe(false);

      expect(await rows(prisma, chatId)).toEqual(before);
      expect(await roleOf(prisma, chatId, "a1")).toBe("assistant");
    },
    30_000
  );

  postgresTest(
    "a finalisation whose body names another message is refused",
    async ({ prisma, postgresContainer }) => {
      const chatId = "chat_finalise_id";
      await boot(prisma, postgresContainer.getConnectionUri(), chatId);

      await persistMessages(agentDb, { chatId, messages: [textMessage("a1", "still working")] });
      const before = await rows(prisma, chatId);

      // The row key would stay `a1` while the body claims `a2`, so a later read
      // would hand the UI a message under the wrong identity.
      await expect(
        finalizeChatMessage(agentDb, {
          chatId,
          messageId: "a1",
          expectedRole: "assistant",
          message: { id: "a2", role: "assistant", parts: [{ type: "text", text: "done" }] },
        })
      ).rejects.toThrow(/finalisation target a1 carries body id a2/);

      expect(await rows(prisma, chatId)).toEqual(before);
    },
    30_000
  );

  postgresTest(
    "the row's role and the body's role cannot be made to disagree",
    async ({ prisma, postgresContainer }) => {
      const chatId = "chat_finalise_drift";
      await boot(prisma, postgresContainer.getConnectionUri(), chatId);

      await persistMessages(agentDb, { chatId, messages: [textMessage("a1")] });

      // The column says assistant, the body would say user. Refused outright rather
      // than stored as a row whose column and payload disagree.
      await expect(
        finalizeChatMessage(agentDb, {
          chatId,
          messageId: "a1",
          expectedRole: "assistant",
          message: { id: "a1", role: "user", parts: [] },
        })
      ).rejects.toThrow(/expected role assistant but its body carries user/);

      expect(await roleOf(prisma, chatId, "a1")).toBe("assistant");
      expect((await rows(prisma, chatId))[0]!.message).toMatchObject({ role: "assistant" });
    },
    30_000
  );

  postgresTest(
    "a finalisation of a message that isn't there writes nothing",
    async ({ prisma, postgresContainer }) => {
      const chatId = "chat_finalise_missing";
      await boot(prisma, postgresContainer.getConnectionUri(), chatId);

      expect(
        await finalizeChatMessage(agentDb, {
          chatId,
          messageId: "never-stored",
          expectedRole: "assistant",
          message: textMessage("never-stored"),
        })
      ).toBe(false);
      expect(await rows(prisma, chatId)).toHaveLength(0);
    },
    30_000
  );
});

describe("invariant 5: re-sending a snapshot is free", () => {
  postgresTest(
    "a re-sent snapshot reserves no position, touches no row and writes no timestamp",
    async ({ prisma, postgresContainer }) => {
      const chatId = "chat_snapshot_free";
      await boot(prisma, postgresContainer.getConnectionUri(), chatId);

      const snapshot = Array.from({ length: 6 }, (_, i) => textMessage(`m${i}`));
      await persistMessages(agentDb, { chatId, messages: snapshot });

      const before = await rows(prisma, chatId);
      const positionBefore = await nextPosition(prisma, chatId);
      const chatBefore = await chatStamps(prisma, chatId);

      await persistMessages(agentDb, { chatId, messages: snapshot });
      await persistTurn(agentDb, {
        chatId,
        messages: snapshot,
        session: { publicAccessToken: "pat_store" },
      });

      expect(await rows(prisma, chatId)).toEqual(before);
      // The allocator is the observable cost: a re-send that reserved slots would grow it.
      expect(await nextPosition(prisma, chatId)).toBe(positionBefore);
      expect(await chatStamps(prisma, chatId)).toEqual(chatBefore);
    },
    30_000
  );

  postgresTest(
    "a transcript grown by re-sent snapshots spends one position per message",
    async ({ prisma, postgresContainer }) => {
      const chatId = "chat_snapshot_slots";
      await boot(prisma, postgresContainer.getConnectionUri(), chatId);

      // The real write pattern: every turn hands over the whole transcript again. With
      // the old insert-everything path this cost 1+2+…+40 = 820 slots for 40 rows.
      const snapshot: ReturnType<typeof textMessage>[] = [];
      for (let i = 0; i < 40; i++) {
        snapshot.push(textMessage(`m${i}`));
        await persistMessages(agentDb, { chatId, messages: [...snapshot] });
      }

      expect(await rows(prisma, chatId)).toHaveLength(40);
      expect(await nextPosition(prisma, chatId)).toBe(41);
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

      // A later turn carrying the card in its own snapshot still can't rewrite it:
      // finalisation is for the turn's messages, never for a durable event.
      const card = (await rows(prisma, chatId)).find((stored) => stored.message_id === cardId)!;
      await persistTurn(agentDb, {
        chatId,
        messages: [{ ...(card.message as Record<string, unknown>), tampered: true }],
        // Even named outright, a durable event is not this turn's to rewrite.
        finalizeMessageIds: [cardId],
        session: { publicAccessToken: "pat_store" },
      });
      const afterCard = (await rows(prisma, chatId)).find(
        (stored) => stored.message_id === cardId
      )!;
      expect(afterCard.message).toEqual(card.message);
    },
    30_000
  );
});

describe("countChatsWithUnreadWork", () => {
  postgresTest(
    "counts a chat whose transcript moved on after its owner last looked",
    async ({ prisma, postgresContainer }) => {
      const chatId = "chat_unread_work";
      await boot(prisma, postgresContainer.getConnectionUri(), chatId);
      const scope = { organizationId: ORG_ID, userId: USER_ID };

      // A chat nobody has written in is not unread.
      expect(await countChatsWithUnreadWork(agentDb, scope)).toBe(0);

      await persistMessages(agentDb, { chatId, messages: [textMessage("a1")] });
      expect(await countChatsWithUnreadWork(agentDb, scope)).toBe(1);

      // Opening it clears the state...
      await prisma.$executeRawUnsafe(
        `update trigger_dashboard_agent.chats set last_read_at = now() where id = $1`,
        chatId
      );
      expect(await countChatsWithUnreadWork(agentDb, scope)).toBe(0);

      // ...until the next answer lands behind a closed panel.
      await persistMessages(agentDb, { chatId, messages: [textMessage("a2")] });
      expect(await countChatsWithUnreadWork(agentDb, scope)).toBe(1);

      // Another user's chat is never counted here.
      expect(
        await countChatsWithUnreadWork(agentDb, { ...scope, userId: "user_someone_else" })
      ).toBe(0);
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

/**
 * A consented watch seeds its card in one run and revises it in another, with no
 * hand-off between them: both name the row off the watch. So seeding twice has to
 * converge on one card, and a row under that id in another chat must be refused
 * rather than revised.
 */
describe("seedInvestigation", () => {
  postgresTest(
    "opens the watch's card once and hands the same row back after that",
    async ({ prisma, postgresContainer }) => {
      await boot(prisma, postgresContainer.getConnectionUri(), "chat_seed");
      await createChat(agentDb, {
        id: "chat_seed_other",
        organizationId: ORG_ID,
        userId: USER_ID,
      });

      const id = watchInvestigationId("watch_seed");
      const seed = (chatId: string) =>
        seedInvestigation(agentDb, {
          id,
          chatId,
          projectRef: PROJECT_REF,
          environmentRef: ENV_REF,
          state: openState(),
        });

      expect(await seed("chat_seed")).toMatchObject({ ok: true, id, created: true });
      // The investigating lane, arriving after the wake already opened it.
      expect(await seed("chat_seed")).toMatchObject({ ok: true, id, created: false });
      expect(await seed("chat_seed_other")).toEqual({ ok: false, error: "context_mismatch" });

      const row = await getInvestigation(agentDb, { id });
      expect(row?.chatId).toBe("chat_seed");
      expect(row?.revision).toBe(0);
    },
    30_000
  );
});
