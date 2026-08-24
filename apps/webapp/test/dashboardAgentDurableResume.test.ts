import {
  appendChatMessageOnceByChatId,
  createChat,
  createDashboardAgentDb,
  getChatMessages,
  getSession,
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
 * Durability of a chat.agent turn across a crash and a resume, against a real table
 * (TRI-11166).
 *
 * The primitive gives chat.agent durability by snapshotting the transcript and replaying it
 * on the next boot. These tests pin the store seam that replay lands on: the completing turn
 * re-sends its whole snapshot, so the store has to fold that replay into exactly one row per
 * message — no double-appended turn, no lost mid-turn message — and reconstruct the session
 * cursor a refreshed client resumes from.
 *
 * What is NOT covered here, because it lives inside the closed chat.agent primitive package
 * (object-store snapshot write, S2 `.in`/`.out` replay, `.out` trimming, OOM restart): the
 * transport-level replay and the snapshot URL's own auth. The client-side reconnect / Last-
 * Event-ID replay is covered in packages/trigger-sdk/src/v3/chat.test.ts. These tests are the
 * store-level backstop those depend on. See the PR body for the residual follow-ups.
 */

let agentDb: DashboardAgentDb;
let agentDbClient: DashboardAgentDbClient | undefined;

const ORG = "org_resume";
const USER = "user_resume";

async function boot(prisma: PrismaClient, connectionUri: string, chatId: string) {
  await applyDashboardAgentMigrations((statement) => prisma.$executeRawUnsafe(statement));
  agentDbClient = createDashboardAgentDb(connectionUri, { max: 4 });
  agentDb = agentDbClient.db;
  await createChat(agentDb, { id: chatId, organizationId: ORG, userId: USER });
}

afterEach(async () => {
  await agentDbClient?.close();
  agentDbClient = undefined;
});

function textMessage(id: string, role: "user" | "assistant" = "assistant", text = id) {
  return { id, role, parts: [{ type: "text", text }] };
}

/** A tool part, so a mid-flight call and its completed result share an id but differ in body. */
function toolMessage(id: string, state: "input-available" | "output-available") {
  return {
    id,
    role: "assistant" as const,
    parts: [{ type: "tool-get_query_schema", state, toolCallId: `${id}_call`, input: {} }],
  };
}

async function transcript(chatId: string): Promise<{ id: string }[]> {
  return (await getChatMessages(agentDb, { chatId, organizationId: ORG, userId: USER })) as {
    id: string;
  }[];
}

/** The allocator, where a wasted/duplicated slot is observable. */
async function nextPosition(prisma: PrismaClient, chatId: string): Promise<number> {
  const rows = await prisma.$queryRawUnsafe<{ next_message_position: number }[]>(
    `select next_message_position from trigger_dashboard_agent.chats where id = $1`,
    chatId
  );
  return rows[0]!.next_message_position;
}

async function rowCount(prisma: PrismaClient, chatId: string): Promise<number> {
  const rows = await prisma.$queryRawUnsafe<{ count: bigint }[]>(
    `select count(*)::int as count from trigger_dashboard_agent.chat_messages where chat_id = $1`,
    chatId
  );
  return Number(rows[0]!.count);
}

describe("a streamed-then-resumed turn is not double-appended", () => {
  postgresTest(
    "re-delivering the completing turn finalises in place and appends nothing",
    async ({ prisma, postgresContainer }) => {
      const chatId = "chat_no_double";
      await boot(prisma, postgresContainer.getConnectionUri(), chatId);

      // The turn started: onTurnStart stored the user turn and the tool call mid-flight.
      await persistMessages(agentDb, {
        chatId,
        messages: [textMessage("u1", "user"), toolMessage("a1", "input-available")],
      });
      expect(await rowCount(prisma, chatId)).toBe(2);

      const completing = {
        chatId,
        messages: [textMessage("u1", "user"), toolMessage("a1", "output-available")],
        finalizeMessageIds: ["a1"],
        session: { publicAccessToken: "pat", lastEventId: "7", runId: "run" },
      };

      // The turn completes, replaying its whole snapshot. `a1` is finalised, not re-added.
      await persistTurn(agentDb, completing);
      // The resume: the same completed turn is delivered again (client reconnected and the
      // host re-persisted). It must converge — no second `a1`, no extra row of any kind.
      await persistTurn(agentDb, completing);

      expect((await transcript(chatId)).map((m) => m.id)).toEqual(["u1", "a1"]);
      expect(await rowCount(prisma, chatId)).toBe(2);
      // Only u1 and a1 ever reserved a slot (allocator starts at 1); the finalisation and the
      // replay reserve none, so the next free position is still 3.
      expect(await nextPosition(prisma, chatId)).toBe(3);
      // And `a1` is the completed body the user saw, not the mid-flight call.
      const stored = (await transcript(chatId))[1] as unknown as {
        parts: { state: string }[];
      };
      expect(stored.parts[0]!.state).toBe("output-available");
    },
    30_000
  );
});

describe("a crash mid-turn is reconstructed by the next boot's replay", () => {
  postgresTest(
    "the resumed turn keeps the mid-turn append, finalises its own message, and rebuilds the session cursor",
    async ({ prisma, postgresContainer }) => {
      const chatId = "chat_crash_resume";
      await boot(prisma, postgresContainer.getConnectionUri(), chatId);

      // Turn in flight: the snapshot it started from, stored before the model finished.
      const snapshot = [textMessage("u1", "user"), toolMessage("a1", "input-available")];
      await persistMessages(agentDb, { chatId, messages: snapshot });

      // A wake lands mid-turn, off its own lane — the message the old replace-the-array
      // write used to lose.
      await appendChatMessageOnceByChatId(agentDb, {
        chatId,
        message: textMessage("wake:w1"),
      });

      // Before the crash there is no session row to resume from.
      expect(await getSession(agentDb, { chatId, organizationId: ORG, userId: USER })).toBeNull();

      // Boot after the crash: replay the whole transcript, finalise the turn's own message,
      // and write the session the client resumes from — all in one persistTurn.
      await persistTurn(agentDb, {
        chatId,
        messages: [
          textMessage("u1", "user"),
          toolMessage("a1", "output-available"),
          textMessage("a2"),
        ],
        finalizeMessageIds: ["a1", "a2"],
        session: { publicAccessToken: "pat_resumed", lastEventId: "99", runId: "run_resumed" },
      });

      // Nothing was lost and the wake sits where it happened: after the snapshot, before the
      // reply the turn went on to produce.
      expect((await transcript(chatId)).map((m) => m.id)).toEqual(["u1", "a1", "wake:w1", "a2"]);

      const session = await getSession(agentDb, { chatId, organizationId: ORG, userId: USER });
      expect(session).toMatchObject({
        publicAccessToken: "pat_resumed",
        lastEventId: "99",
        runId: "run_resumed",
      });
    },
    30_000
  );
});

describe("the session cursor a refreshed client resumes from", () => {
  postgresTest(
    "getSession returns the last persisted cursor, and a later turn advances it",
    async ({ prisma, postgresContainer }) => {
      const chatId = "chat_cursor";
      await boot(prisma, postgresContainer.getConnectionUri(), chatId);

      await persistTurn(agentDb, {
        chatId,
        messages: [textMessage("u1", "user"), textMessage("a1")],
        session: { publicAccessToken: "pat1", lastEventId: "10", runId: "run1" },
      });
      // A mid-stream refresh reads exactly this cursor and resumes .out from it.
      expect(
        (await getSession(agentDb, { chatId, organizationId: ORG, userId: USER }))?.lastEventId
      ).toBe("10");

      // The next turn overwrites the cursor — a stale value is replaced, never appended.
      await persistTurn(agentDb, {
        chatId,
        messages: [textMessage("u1", "user"), textMessage("a1"), textMessage("a2")],
        session: { publicAccessToken: "pat2", lastEventId: "25", runId: "run2" },
      });
      const session = await getSession(agentDb, { chatId, organizationId: ORG, userId: USER });
      expect(session).toMatchObject({
        publicAccessToken: "pat2",
        lastEventId: "25",
        runId: "run2",
      });
    },
    30_000
  );
});

describe("a failed snapshot write leaves the next boot a clean replay", () => {
  postgresTest(
    "a persistTurn that throws mid-write rolls back what it already wrote, and the retry replays with no loss",
    async ({ prisma, postgresContainer }) => {
      const chatId = "chat_write_fail";
      await boot(prisma, postgresContainer.getConnectionUri(), chatId);

      // A durable first turn, its tool call still mid-flight, and the session cursor it left.
      await persistTurn(agentDb, {
        chatId,
        messages: [textMessage("u1", "user"), toolMessage("a1", "input-available")],
        session: { publicAccessToken: "pat1", lastEventId: "1", runId: "run1" },
      });
      const positionBefore = await nextPosition(prisma, chatId);

      // Tear the next turn at the INSERT itself, so the failure lands after `a1` is finalised
      // in place and after the slots are reserved no matter how the store orders its up-front
      // validation. A row planted directly at the position the allocator is about to hand out
      // makes that insert violate `chat_messages_chat_position_key`. Scaffolding, not part of
      // the transcript under test — removed once the tear has fired.
      await prisma.$executeRawUnsafe(
        `insert into trigger_dashboard_agent.chat_messages (chat_id, message_id, position, role, message)
         values ($1, 'planted_collision', $2, 'assistant', '{}'::jsonb)`,
        chatId,
        positionBefore
      );

      // The driver names the failing statement, so the rejection itself pins where the tear fired.
      await expect(
        persistTurn(agentDb, {
          chatId,
          messages: [
            textMessage("u1", "user"),
            toolMessage("a1", "output-available"),
            textMessage("a2"),
          ],
          finalizeMessageIds: ["a1"],
          session: { publicAccessToken: "pat_torn", lastEventId: "2", runId: "run_torn" },
        })
      ).rejects.toThrow(/Failed query: insert into .*chat_messages/);

      await prisma.$executeRawUnsafe(
        `delete from trigger_dashboard_agent.chat_messages where chat_id = $1 and message_id = 'planted_collision'`,
        chatId
      );

      // The whole turn rolled back. The in-place rewrite the store had already applied is undone:
      // `a1` is the mid-flight call again, not the finalised body the torn turn wrote.
      expect((await transcript(chatId)).map((m) => m.id)).toEqual(["u1", "a1"]);
      const tornA1 = (await transcript(chatId))[1] as unknown as { parts: { state: string }[] };
      expect(tornA1.parts[0]!.state).toBe("input-available");
      expect(await rowCount(prisma, chatId)).toBe(2);
      // The slot it reserved for `a2` came back too, so the retry doesn't leave a gap.
      expect(await nextPosition(prisma, chatId)).toBe(positionBefore);
      // The cursor is still the first turn's: the failed turn never got as far as writing one.
      expect(
        await getSession(agentDb, { chatId, organizationId: ORG, userId: USER })
      ).toMatchObject({ publicAccessToken: "pat1", lastEventId: "1" });

      // The retry — a clean replay of the same turn — lands everything exactly once.
      await persistTurn(agentDb, {
        chatId,
        messages: [
          textMessage("u1", "user"),
          toolMessage("a1", "output-available"),
          textMessage("a2"),
        ],
        finalizeMessageIds: ["a1"],
        session: { publicAccessToken: "pat2", lastEventId: "2", runId: "run2" },
      });
      expect((await transcript(chatId)).map((m) => m.id)).toEqual(["u1", "a1", "a2"]);
      const retriedA1 = (await transcript(chatId))[1] as unknown as { parts: { state: string }[] };
      expect(retriedA1.parts[0]!.state).toBe("output-available");
      // One new row, one new slot: the rolled-back reservation was not double-counted.
      expect(await nextPosition(prisma, chatId)).toBe(positionBefore + 1);
      expect(
        await getSession(agentDb, { chatId, organizationId: ORG, userId: USER })
      ).toMatchObject({ publicAccessToken: "pat2", lastEventId: "2" });
    },
    30_000
  );
});

describe("an OOM restart replays the turn cleanly", () => {
  postgresTest(
    "a restarted turn that re-sends its snapshot loses no data and doubles nothing",
    async ({ prisma, postgresContainer }) => {
      // The store seam an OOM restart lands on: the primitive restarts the run, replays `.in`,
      // and re-persists. `.out` trimming and the OOM restart itself are inside the primitive
      // (not reachable here) — this pins that a re-run's re-sent snapshot is idempotent.
      const chatId = "chat_oom_restart";
      await boot(prisma, postgresContainer.getConnectionUri(), chatId);

      const firstAttempt = [textMessage("u1", "user"), toolMessage("a1", "input-available")];
      await persistMessages(agentDb, { chatId, messages: firstAttempt });
      const positionAfterFirst = await nextPosition(prisma, chatId);

      // The run OOMs and restarts. It replays the same input, produces the same ids, and
      // finalises the turn it now completes.
      const restarted = {
        chatId,
        messages: [
          textMessage("u1", "user"),
          toolMessage("a1", "output-available"),
          textMessage("a2"),
        ],
        finalizeMessageIds: ["a1", "a2"],
        session: { publicAccessToken: "pat", lastEventId: "5", runId: "run_restarted" },
      };
      await persistTurn(agentDb, restarted);
      // A second restart delivering the same turn again still converges.
      await persistTurn(agentDb, restarted);

      expect((await transcript(chatId)).map((m) => m.id)).toEqual(["u1", "a1", "a2"]);
      // The replayed u1/a1 reserved no new slots; only a2 was genuinely new.
      expect(await nextPosition(prisma, chatId)).toBe(positionAfterFirst + 1);
    },
    30_000
  );
});
