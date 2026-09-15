import {
  createChat,
  createDashboardAgentDb,
  getChatMessages,
  getInvestigation,
  listStaleOpenInvestigations,
  settleInvestigationStateAndCloseCard,
  softDeleteChat,
  upsertInvestigationRevision,
  type DashboardAgentDb,
  type DashboardAgentDbClient,
} from "@internal/dashboard-agent-db";
import { applyDashboardAgentMigrations } from "@internal/dashboard-agent-db/testing";
import {
  forceSettledInvestigationState,
  investigationStateSchema,
  type InvestigationState,
} from "@internal/dashboard-agent-contracts";
import { postgresTest } from "@internal/testcontainers";
import type { PrismaClient } from "@trigger.dev/database";
import { afterEach, describe, expect } from "vitest";

/**
 * The write the consented watch investigation closes its card with.
 *
 * The lane has no `onTurnComplete` to hand settlements to, so it closes the card
 * itself. Settling the row and appending the terminal card used to be two operations
 * with the append's error swallowed: the row went terminal, the card never arrived,
 * the stale sweep stopped selecting the row, and the panel kept spinning for ever.
 */

let agentDb: DashboardAgentDb;
let agentDbClient: DashboardAgentDbClient | undefined;

const ORG_ID = "org_watch_card";
const USER_ID = "user_watch_card";
const PROJECT_REF = "proj_watch_card";
const ENV_REF = "env_watch_card";
const MESSAGE_ID = "investigate:watch:watch_1:fired:investigate:settled";

async function boot(prisma: PrismaClient, connectionUri: string, chatId: string) {
  await applyDashboardAgentMigrations((statement) => prisma.$executeRawUnsafe(statement));
  agentDbClient = createDashboardAgentDb(connectionUri, { max: 2 });
  agentDb = agentDbClient.db;
  await createChat(agentDb, { id: chatId, organizationId: ORG_ID, userId: USER_ID });
}

afterEach(async () => {
  await agentDbClient?.close();
  agentDbClient = undefined;
});

function openState(): InvestigationState {
  return investigationStateSchema.parse({
    outcome: "in_progress",
    severity: "warn",
    confidence: "low",
    title: "Investigating run_abc123",
    headline: "The run finished with errors. Looking into why.",
    hypotheses: [],
    evidence: [],
  });
}

async function seed(chatId: string, state: unknown): Promise<string> {
  const created = await upsertInvestigationRevision(agentDb, {
    chatId,
    projectRef: PROJECT_REF,
    environmentRef: ENV_REF,
    state,
  });
  if (!created.ok) throw new Error("the fixture investigation wasn't created");
  return created.id;
}

async function transcript(chatId: string): Promise<{ id: string; parts: any[] }[]> {
  return (await getChatMessages(agentDb, {
    chatId,
    userId: USER_ID,
    organizationId: ORG_ID,
  })) as { id: string; parts: any[] }[];
}

describe("closing a consented watch investigation's card", () => {
  postgresTest(
    "commits the terminal revision and the card together, under the lane's own message id",
    async ({ prisma, postgresContainer }) => {
      const chatId = "chat_watch_card";
      await boot(prisma, postgresContainer.getConnectionUri(), chatId);
      const id = await seed(chatId, openState());

      const result = await settleInvestigationStateAndCloseCard(agentDb, {
        id,
        chatId,
        projectRef: PROJECT_REF,
        environmentRef: ENV_REF,
        state: forceSettledInvestigationState(openState()),
        messageId: MESSAGE_ID,
      });
      expect(result).toMatchObject({ ok: true, id, revision: 1, closed: true });

      const stored = await transcript(chatId);
      expect(stored.map((message) => message.id)).toEqual([MESSAGE_ID]);
      expect(stored[0]!.parts[0]!.output.blocks[0]).toMatchObject({ id, revision: 1 });
      expect(stored[0]!.parts[0]!.output.blocks[0].investigation.outcome).toBe("inconclusive");
      expect(
        investigationStateSchema.parse((await getInvestigation(agentDb, { id }))?.state).outcome
      ).toBe("inconclusive");

      // The lane dedupes on the action, so a redelivered kick closes nothing twice —
      // and must not bump the revision, or the row runs ahead of the stored card.
      const again = await settleInvestigationStateAndCloseCard(agentDb, {
        id,
        chatId,
        projectRef: PROJECT_REF,
        environmentRef: ENV_REF,
        state: forceSettledInvestigationState(openState()),
        messageId: MESSAGE_ID,
      });
      expect(again).toMatchObject({ ok: true, id, revision: 1, closed: false });
      expect((await getInvestigation(agentDb, { id }))?.revision).toBe(1);

      const after = await transcript(chatId);
      expect(after.map((message) => message.id)).toEqual([MESSAGE_ID]);
      expect(after[0]!.parts[0]!.output.blocks[0]).toMatchObject({ id, revision: 1 });
      // The replayed result is the card the transcript holds, not a second rendering.
      expect((again as { card: unknown }).card).toEqual(after[0]);
    },
    30_000
  );

  postgresTest(
    "settles nothing when the chat was deleted, so the sweep still selects the row",
    async ({ prisma, postgresContainer }) => {
      const chatId = "chat_watch_card_deleted";
      await boot(prisma, postgresContainer.getConnectionUri(), chatId);
      const id = await seed(chatId, openState());
      await softDeleteChat(agentDb, { chatId, userId: USER_ID, organizationId: ORG_ID });

      expect(
        await settleInvestigationStateAndCloseCard(agentDb, {
          id,
          chatId,
          projectRef: PROJECT_REF,
          environmentRef: ENV_REF,
          state: forceSettledInvestigationState(openState()),
          messageId: MESSAGE_ID,
        })
      ).toEqual({ ok: false, error: "chat_missing" });

      const row = await getInvestigation(agentDb, { id });
      expect(row?.revision).toBe(0);
      expect((row!.state as { outcome?: string }).outcome).toBe("in_progress");
    },
    30_000
  );

  postgresTest(
    "settles nothing when the chat row was never there",
    async ({ prisma, postgresContainer }) => {
      const chatId = "chat_watch_card_absent";
      await boot(prisma, postgresContainer.getConnectionUri(), "chat_watch_card_present");
      const id = await seed(chatId, openState());

      expect(
        await settleInvestigationStateAndCloseCard(agentDb, {
          id,
          chatId,
          projectRef: PROJECT_REF,
          environmentRef: ENV_REF,
          state: forceSettledInvestigationState(openState()),
          messageId: MESSAGE_ID,
        })
      ).toEqual({ ok: false, error: "chat_missing" });

      const row = await getInvestigation(agentDb, { id });
      expect(row?.revision).toBe(0);
      expect((row!.state as { outcome?: string }).outcome).toBe("in_progress");
    },
    30_000
  );

  /**
   * The regression. A terminal row with no terminal card must be impossible: if the
   * card can't be written the settle rolls back, so the row stays `in_progress` and the
   * stale sweep still selects it.
   */
  postgresTest(
    "a card that can't be written rolls the settle back, leaving the row in_progress",
    async ({ prisma, postgresContainer }) => {
      const chatId = "chat_watch_card_fails";
      await boot(prisma, postgresContainer.getConnectionUri(), chatId);
      const id = await seed(chatId, openState());

      // A state the row accepts but no card can be rendered from, so the delivery half
      // genuinely fails against a real database.
      await expect(
        settleInvestigationStateAndCloseCard(agentDb, {
          id,
          chatId,
          projectRef: PROJECT_REF,
          environmentRef: ENV_REF,
          state: { outcome: "inconclusive" },
          messageId: MESSAGE_ID,
        })
      ).rejects.toThrow(/isn't renderable/);

      const row = await getInvestigation(agentDb, { id });
      expect(row?.revision).toBe(0);
      expect((row!.state as { outcome?: string }).outcome).toBe("in_progress");
      expect(await transcript(chatId)).toEqual([]);

      // Still selectable, so the backstop sweep can finish the job.
      const stale = await listStaleOpenInvestigations(agentDb, {
        olderThan: new Date(),
        limit: 10,
      });
      expect(stale.map((candidate) => candidate.id)).toEqual([id]);
    },
    30_000
  );

  postgresTest(
    "refuses a row that belongs to another project, and writes nothing",
    async ({ prisma, postgresContainer }) => {
      const chatId = "chat_watch_card_tenancy";
      await boot(prisma, postgresContainer.getConnectionUri(), chatId);
      const id = await seed(chatId, openState());

      expect(
        await settleInvestigationStateAndCloseCard(agentDb, {
          id,
          chatId,
          projectRef: "proj_someone_else",
          environmentRef: ENV_REF,
          state: forceSettledInvestigationState(openState()),
          messageId: MESSAGE_ID,
        })
      ).toEqual({ ok: false, error: "context_mismatch" });

      expect(await transcript(chatId)).toEqual([]);
      expect((await getInvestigation(agentDb, { id }))?.revision).toBe(0);
    },
    30_000
  );
});
