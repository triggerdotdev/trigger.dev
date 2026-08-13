import {
  forceSettledInvestigationState,
  investigationStateSchema,
  UNSETTLED_INVESTIGATION_NOTE,
  VIEW_BLOCK_VERSION,
  type InvestigationState,
} from "@internal/dashboard-agent-contracts";
import {
  createChat,
  createDashboardAgentDb,
  getChatMessages,
  getInvestigation,
  investigationSettlementMessage,
  investigationSettlementMessageId,
  listStaleOpenInvestigations,
  settleInvestigationAndCloseCard,
  upsertInvestigationRevision,
  type DashboardAgentDb,
  type DashboardAgentDbClient,
  type Investigation,
  type InvestigationCardMessage,
} from "@internal/dashboard-agent-db";
import { applyDashboardAgentMigrations } from "@internal/dashboard-agent-db/testing";
import { postgresTest } from "@internal/testcontainers";
import { afterEach, describe, expect, it } from "vitest";
import {
  INVESTIGATION_STALE_MS,
  MAX_SWEEP_ATTEMPTS,
  sweepDashboardAgentInvestigations,
} from "./investigation-sweep";
import { watchConnectionString } from "./watch-task-adapters";

const ORG = "org_sweep";
const USER = "user_sweep";
const PROJECT_REF = "proj_sweep";
const ENV_REF = "env_sweep";

/** Comfortably past the grace window. */
const STALE_AGE_MS = INVESTIGATION_STALE_MS + 60_000;

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

function openState(overrides: Partial<InvestigationState> = {}): InvestigationState {
  return investigationStateSchema.parse({
    outcome: "in_progress",
    severity: "warn",
    confidence: "medium",
    title: "send-order-receipt keeps failing",
    headline: "Checking whether the failures share a payload.",
    progress: "Reading the run's spans",
    checkNext: [],
    hypotheses: [
      {
        id: "h1",
        statement: "The new payload dropped a field the task reads.",
        verdict: "testing",
        evidence: [],
      },
    ],
    evidence: [],
    ...overrides,
  });
}

async function seedChat(db: DashboardAgentDb, id: string, options: { deleted?: boolean } = {}) {
  await createChat(db, { id, organizationId: ORG, userId: USER });
  if (options.deleted) {
    await raw(`update trigger_dashboard_agent.chats set deleted_at = now() where id = $1`, [id]);
  }
}

async function seedInvestigation(
  db: DashboardAgentDb,
  args: { chatId: string; state: InvestigationState; ageMs?: number }
): Promise<string> {
  const created = await upsertInvestigationRevision(db, {
    chatId: args.chatId,
    projectRef: PROJECT_REF,
    environmentRef: ENV_REF,
    state: args.state,
  });
  if (!created.ok) throw new Error("the fixture investigation wasn't created");

  if (args.ageMs !== undefined) {
    await raw(
      `update trigger_dashboard_agent.investigations
       set updated_at = now() - ($2 || ' milliseconds')::interval where id = $1`,
      [created.id, String(args.ageMs)]
    );
  }
  return created.id;
}

async function outcomeOf(db: DashboardAgentDb, id: string): Promise<string | undefined> {
  const row = await getInvestigation(db, { id });
  return row ? (row.state as { outcome?: string }).outcome : undefined;
}

function messagesOf(db: DashboardAgentDb, chatId: string) {
  return getChatMessages(db, { chatId, userId: USER, organizationId: ORG }) as Promise<
    { id: string; parts: Record<string, any>[] }[] | null
  >;
}

describe("the dashboard agent investigation sweep", () => {
  postgresTest(
    "settles a card left in_progress, keeping what was established",
    async ({ postgresContainer }) => {
      const db = await boot(postgresContainer.getConnectionUri());
      await seedChat(db, "chat_stale");
      const id = await seedInvestigation(db, {
        chatId: "chat_stale",
        state: openState(),
        ageMs: STALE_AGE_MS,
      });

      const result = await sweepDashboardAgentInvestigations(db);
      expect(result).toMatchObject({
        stale: 1,
        settled: 1,
        closed: 1,
        alreadySettled: 0,
        failed: 0,
      });

      const row = await getInvestigation(db, { id });
      const state = investigationStateSchema.parse(row?.state);
      expect(state.outcome).toBe("inconclusive");
      expect(state.confidence).toBe("low");
      expect(state.headline).toBe(
        `Checking whether the failures share a payload. ${UNSETTLED_INVESTIGATION_NOTE}`
      );
      expect(state.progress).toBeUndefined();
      expect(state.remediation).toBeUndefined();
      expect(state.hypotheses).toHaveLength(1);
      expect(state.title).toBe("send-order-receipt keeps failing");
      expect(row?.revision).toBe(1);

      // The settled row is invisible on its own: the panel resolves the card from the
      // transcript, so the closing revision has to be in the chat too.
      const messages = await messagesOf(db, "chat_stale");
      expect(messages?.map((message) => message.id)).toEqual([
        investigationSettlementMessageId(id, 1),
      ]);
      const block = messages![0]!.parts[0]!.output.blocks[0];
      expect(block).toMatchObject({ type: "investigation", id, revision: 1 });
      expect(block.investigation.outcome).toBe("inconclusive");

      // A second run can't stack a second card: the settle is a no-op and the append
      // is deduped on the same message id.
      expect(await sweepDashboardAgentInvestigations(db)).toMatchObject({ stale: 0, settled: 0 });
      expect((await messagesOf(db, "chat_stale"))?.length).toBe(1);
    },
    60_000
  );

  postgresTest(
    "drops a fix a concluded card was carrying",
    async ({ postgresContainer }) => {
      const db = await boot(postgresContainer.getConnectionUri());
      await seedChat(db, "chat_fix");
      // An inconclusive card may not offer a fix, so the settle strips remediation.
      const id = await seedInvestigation(db, {
        chatId: "chat_fix",
        state: { ...openState(), remediation: "Raise the timeout." } as InvestigationState,
        ageMs: STALE_AGE_MS,
      });

      await sweepDashboardAgentInvestigations(db);

      const row = await getInvestigation(db, { id });
      expect(investigationStateSchema.parse(row?.state).remediation).toBeUndefined();
    },
    60_000
  );

  postgresTest(
    "leaves a fresh in_progress card alone — a live turn is never swept",
    async ({ postgresContainer }) => {
      const db = await boot(postgresContainer.getConnectionUri());
      await seedChat(db, "chat_fresh");
      const id = await seedInvestigation(db, { chatId: "chat_fresh", state: openState() });

      expect(await sweepDashboardAgentInvestigations(db)).toMatchObject({ stale: 0, settled: 0 });
      const row = await getInvestigation(db, { id });
      expect(investigationStateSchema.parse(row?.state).outcome).toBe("in_progress");
      expect(row?.revision).toBe(0);
    },
    60_000
  );

  postgresTest(
    "leaves a card that already has an answer alone",
    async ({ postgresContainer }) => {
      const db = await boot(postgresContainer.getConnectionUri());
      await seedChat(db, "chat_done");
      const id = await seedInvestigation(db, {
        chatId: "chat_done",
        state: openState({
          outcome: "inconclusive",
          progress: undefined,
          headline: "Not established: the failures span two versions.",
        }),
        ageMs: STALE_AGE_MS,
      });

      expect(await sweepDashboardAgentInvestigations(db)).toMatchObject({ stale: 0, settled: 0 });
      const row = await getInvestigation(db, { id });
      expect(row?.revision).toBe(0);
      expect(investigationStateSchema.parse(row?.state).headline).toBe(
        "Not established: the failures span two versions."
      );
    },
    60_000
  );

  postgresTest(
    "skips a card in a deleted chat",
    async ({ postgresContainer }) => {
      const db = await boot(postgresContainer.getConnectionUri());
      await seedChat(db, "chat_gone", { deleted: true });
      await seedInvestigation(db, {
        chatId: "chat_gone",
        state: openState(),
        ageMs: STALE_AGE_MS,
      });

      expect(await sweepDashboardAgentInvestigations(db)).toMatchObject({ stale: 0, settled: 0 });
    },
    60_000
  );

  postgresTest(
    "a turn that concludes the card first wins: the settle is a no-op, not an error",
    async ({ postgresContainer }) => {
      const db = await boot(postgresContainer.getConnectionUri());
      await seedChat(db, "chat_race");
      const id = await seedInvestigation(db, {
        chatId: "chat_race",
        state: openState(),
        ageMs: STALE_AGE_MS,
      });

      const stale = await listStaleOpenInvestigations(db, { olderThan: new Date(), limit: 10 });
      expect(stale.map((row) => row.id)).toEqual([id]);

      const concluded = await upsertInvestigationRevision(db, {
        id,
        chatId: "chat_race",
        projectRef: PROJECT_REF,
        environmentRef: ENV_REF,
        state: openState({
          outcome: "concluded",
          confidence: "high",
          progress: undefined,
          headline: "receipt.ts:42 reads a field the new payload no longer carries.",
          remediation: "Guard the dereference and backfill the field.",
        }),
      });
      expect(concluded.ok).toBe(true);

      const result = await sweepDashboardAgentInvestigations(db, { listStale: async () => stale });
      expect(result).toMatchObject({
        stale: 1,
        settled: 0,
        closed: 0,
        alreadySettled: 1,
        failed: 0,
      });

      const row = await getInvestigation(db, { id });
      const state = investigationStateSchema.parse(row?.state);
      expect(state.outcome).toBe("concluded");
      expect(state.headline).not.toContain(UNSETTLED_INVESTIGATION_NOTE);
      expect(row?.revision).toBe(1);
    },
    60_000
  );

  /**
   * The failure window. Settling the row and delivering its card used to be two
   * operations: once the row was terminal, a failed append left a card reading
   * `in_progress` that nothing would ever repair, because this sweep only selects
   * `in_progress` rows. They must land together or not at all.
   */
  postgresTest(
    "a card that can't be delivered leaves the row in_progress, so the next run retries it",
    async ({ postgresContainer }) => {
      const db = await boot(postgresContainer.getConnectionUri());
      await seedChat(db, "chat_undeliverable");
      // A state the settle can merge but no card can be rendered from, so the delivery
      // half genuinely fails against a real database.
      const id = await seedInvestigation(db, {
        chatId: "chat_undeliverable",
        state: { outcome: "in_progress" } as unknown as InvestigationState,
        ageMs: STALE_AGE_MS,
      });

      await expect(sweepDashboardAgentInvestigations(db)).rejects.toThrow(
        /failed on 1 investigations/
      );

      // The settle rolled back with the card: no half-applied terminal row.
      const row = await getInvestigation(db, { id });
      expect(row?.revision).toBe(0);
      expect((row!.state as { outcome?: string }).outcome).toBe("in_progress");
      expect(await messagesOf(db, "chat_undeliverable")).toEqual([]);

      // And it is still in the selection, so the sweep keeps trying rather than
      // leaving a permanent spinner behind.
      const stale = await listStaleOpenInvestigations(db, { olderThan: new Date(), limit: 10 });
      expect(stale.map((candidate) => candidate.id)).toEqual([id]);
    },
    60_000
  );

  postgresTest(
    "one failing row doesn't cost the batch, and the run throws so the job retries",
    async ({ postgresContainer }) => {
      const db = await boot(postgresContainer.getConnectionUri());
      await seedChat(db, "chat_batch");
      const first = await seedInvestigation(db, {
        chatId: "chat_batch",
        state: openState(),
        ageMs: STALE_AGE_MS + 60_000,
      });
      const second = await seedInvestigation(db, {
        chatId: "chat_batch",
        state: openState(),
        ageMs: STALE_AGE_MS,
      });

      const attempted: string[] = [];
      await expect(
        sweepDashboardAgentInvestigations(db, {
          settleAndClose: async (params) => {
            attempted.push(params.id);
            if (params.id === first) throw new Error("the settle failed");
            return settleInvestigationAndCloseCard(db, params);
          },
        })
      ).rejects.toThrow(/failed on 1 investigations/);

      expect(attempted).toEqual([first, second]);
      expect(await outcomeOf(db, second)).toBe("inconclusive");
      const stuck = await getInvestigation(db, { id: first });
      expect(stuck?.revision).toBe(0);
      expect(await outcomeOf(db, first)).toBe("in_progress");
    },
    60_000
  );
});

describe("the investigation sweep with a poison row", () => {
  postgresTest(
    "a row that always fails to settle cannot pin the head and starve a newer row",
    async ({ postgresContainer }) => {
      const db = await boot(postgresContainer.getConnectionUri());

      // Poison sorts first (older `updated_at`); renderable is newer.
      await seedChat(db, "chat_poison");
      const poisonId = await seedInvestigation(db, {
        chatId: "chat_poison",
        state: openState(),
        ageMs: STALE_AGE_MS + 60_000,
      });
      await seedChat(db, "chat_ok");
      const renderableId = await seedInvestigation(db, {
        chatId: "chat_ok",
        state: openState(),
        ageMs: STALE_AGE_MS,
      });

      // Only the poison row's settle throws; the renderable one goes through the real path.
      const settleAndClose = (params: { id: string; chatId: string; note: string }) => {
        if (params.id === poisonId) throw new Error("state isn't renderable");
        return settleInvestigationAndCloseCard(db, params);
      };

      // limit 1 forces head contention: without backoff the poison row would win every run.
      // A failed run throws so the job retries, but the attempt is recorded before it does.
      await expect(
        sweepDashboardAgentInvestigations(db, { limit: 1, settleAndClose })
      ).rejects.toThrow();
      expect(await outcomeOf(db, poisonId)).toBe("in_progress");
      expect(await outcomeOf(db, renderableId)).toBe("in_progress");

      // Next run: the poison row now sorts behind the never-attempted renderable one,
      // so the newer row is picked and settled despite the poison row still being stale.
      const second = await sweepDashboardAgentInvestigations(db, { limit: 1, settleAndClose });
      expect(second).toMatchObject({ stale: 1, settled: 1, failed: 0 });
      expect(await outcomeOf(db, renderableId)).toBe("inconclusive");
      expect(await outcomeOf(db, poisonId)).toBe("in_progress");
    },
    60_000
  );

  postgresTest(
    "after the attempt cap the poison row is abandoned and leaves the queue",
    async ({ postgresContainer }) => {
      const db = await boot(postgresContainer.getConnectionUri());
      await seedChat(db, "chat_poison");
      const poisonId = await seedInvestigation(db, {
        chatId: "chat_poison",
        state: openState(),
        ageMs: STALE_AGE_MS,
      });

      const settleAndClose = () => {
        throw new Error("state isn't renderable");
      };

      // The first MAX_SWEEP_ATTEMPTS-1 runs record a failed attempt and throw; the row stays stale.
      for (let i = 1; i < MAX_SWEEP_ATTEMPTS; i++) {
        await expect(sweepDashboardAgentInvestigations(db, { settleAndClose })).rejects.toThrow();
        expect(await outcomeOf(db, poisonId)).toBe("in_progress");
      }

      // The capped run force-settles the row without the render path, so it leaves the queue.
      const capped = await sweepDashboardAgentInvestigations(db, { settleAndClose });
      expect(capped).toMatchObject({ stale: 1, abandoned: 1, failed: 0 });
      expect(await outcomeOf(db, poisonId)).toBe("inconclusive");

      // Nothing stale remains, so the poison row is no longer swept.
      expect(await sweepDashboardAgentInvestigations(db, { settleAndClose })).toMatchObject({
        stale: 0,
      });
    },
    60_000
  );
});

/**
 * The closing card's shape, without a container: every write is injected, so the db is
 * never reached.
 */
describe("the investigation sweep's closing card", () => {
  const CHAT_ID = "chat_sweep_card";
  const INVESTIGATION_ID = "inv_sweep_card";
  const noDb = undefined as unknown as DashboardAgentDb;

  function staleRow(state: InvestigationState): Investigation {
    return {
      id: INVESTIGATION_ID,
      chatId: CHAT_ID,
      projectRef: PROJECT_REF,
      environmentRef: ENV_REF,
      revision: 0,
      state,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as Investigation;
  }

  /**
   * Stands in for the datastore: the conditional settle (`in_progress` only) and the
   * id-deduped append, as one operation — which is what the real query is, so a
   * half-applied settle can't exist.
   */
  function fakeStore(initial: InvestigationState) {
    const row = { revision: 0, state: initial };
    const appended: InvestigationCardMessage[] = [];
    return {
      row,
      appended,
      settleAndClose: async (params: { id: string; chatId: string; note: string }) => {
        if (investigationStateSchema.parse(row.state).outcome !== "in_progress") return null;
        const state = forceSettledInvestigationState(investigationStateSchema.parse(row.state));
        const revision = row.revision + 1;

        const message = investigationSettlementMessage({
          investigationId: params.id,
          revision,
          state,
        });
        if (!message) throw new Error("the closing card didn't validate");

        row.state = state;
        row.revision = revision;
        const closed = !appended.some((existing) => existing.id === message.id);
        if (closed) appended.push(message);
        return { settled: { id: params.id, revision, state }, closed };
      },
    };
  }

  it("appends the terminal card to the chat, so the panel stops spinning", async () => {
    const open = openState();
    const store = fakeStore(open);

    const result = await sweepDashboardAgentInvestigations(noDb, {
      listStale: async () => [staleRow(open)],
      settleAndClose: store.settleAndClose,
    });

    expect(store.appended).toHaveLength(1);
    expect(result).toMatchObject({ stale: 1, settled: 1, closed: 1, alreadySettled: 0, failed: 0 });

    const message = store.appended[0]!;
    expect(message.id).toBe(investigationSettlementMessageId(INVESTIGATION_ID, 1));
    expect(message.role).toBe("assistant");

    const part = message.parts[0] as {
      type: string;
      state: string;
      output: { blocks: Record<string, any>[] };
    };
    expect(part.type).toBe("tool-render_view");
    expect(part.state).toBe("output-available");
    expect(part.output.blocks[0]).toMatchObject({
      type: "investigation",
      id: INVESTIGATION_ID,
      revision: 1,
      version: VIEW_BLOCK_VERSION,
    });
    const settled = part.output.blocks[0]!.investigation;
    expect(settled.outcome).toBe("inconclusive");
    expect(settled.confidence).toBe("low");
    expect(settled.progress).toBeUndefined();
    expect(settled.headline).toContain(UNSETTLED_INVESTIGATION_NOTE);
    // What was checked survives: the card closes honestly, it doesn't get blanked.
    expect(settled.hypotheses).toHaveLength(1);
  });

  it("a retried run neither duplicates the card nor opens a second investigation", async () => {
    const open = openState();
    const store = fakeStore(open);
    const deps = {
      listStale: async () => [staleRow(open)],
      settleAndClose: store.settleAndClose,
    };

    await sweepDashboardAgentInvestigations(noDb, deps);
    const second = await sweepDashboardAgentInvestigations(noDb, deps);

    expect(store.appended.map((message) => message.id)).toEqual([
      investigationSettlementMessageId(INVESTIGATION_ID, 1),
    ]);
    expect(second).toMatchObject({ stale: 1, settled: 0, closed: 0, alreadySettled: 1, failed: 0 });
    expect(store.row.revision).toBe(1);
  });
});

describe("the investigation sweep database guard", () => {
  it("skips rather than throwing when neither url is set", () => {
    expect(watchConnectionString({} as NodeJS.ProcessEnv)).toBeUndefined();
  });

  it("falls back to the main database url", () => {
    expect(watchConnectionString({ DATABASE_URL: "postgres://main" } as NodeJS.ProcessEnv)).toBe(
      "postgres://main"
    );
  });

  it("uses the agent's own url when it is set", () => {
    expect(
      watchConnectionString({
        DASHBOARD_AGENT_DATABASE_URL: "postgres://agent",
        DATABASE_URL: "postgres://main",
      } as NodeJS.ProcessEnv)
    ).toBe("postgres://agent");
  });

  it("treats an empty dedicated url as unset", () => {
    expect(
      watchConnectionString({
        DASHBOARD_AGENT_DATABASE_URL: "",
        DATABASE_URL: "postgres://main",
      } as NodeJS.ProcessEnv)
    ).toBe("postgres://main");
  });
});
