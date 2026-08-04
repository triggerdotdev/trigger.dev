// The between-turns investigation backstop, against a REAL Postgres.
//
// No fake datastore: the container runs the dashboard-agent schema, so what is
// under test is the real SQL — the `outcome = 'in_progress'` predicate and the
// `updated_at` window that decide which cards are stale, and the jsonb merge that
// settles one without fighting a live revision.
//
// The one thing injected is the pair of queries themselves, and only in the tests
// that need a state the real queries can't produce on their own: a row concluded
// between the list and the write, and a settle that throws.
import {
  createChat,
  createDashboardAgentDb,
  getInvestigation,
  listStaleOpenInvestigations,
  settleInvestigationAsInconclusive,
  upsertInvestigationRevision,
  type DashboardAgentDb,
  type DashboardAgentDbClient,
} from "@internal/dashboard-agent-db";
import {
  investigationStateSchema,
  UNSETTLED_INVESTIGATION_NOTE,
  type InvestigationState,
} from "@internal/dashboard-agent-contracts";
import { postgresTest } from "@internal/testcontainers";
import type { PrismaClient } from "@trigger.dev/database";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, vi } from "vitest";

const ctx = vi.hoisted(() => ({
  agentDb: undefined as unknown as DashboardAgentDb,
}));

vi.mock("~/services/dashboardAgentDb.server", () => ({
  get dashboardAgentDb() {
    return ctx.agentDb;
  },
}));

const { sweepDashboardAgentInvestigations, INVESTIGATION_STALE_MS } =
  await import("~/services/dashboardAgentInvestigationSweep.server");

/**
 * Apply the dashboard-agent schema by replaying its Drizzle migration SQL —
 * every migration in the folder, in order, so a new migration can never leave
 * this suite running against a stale schema.
 */
async function applyAgentSchema(prisma: PrismaClient) {
  const folder = path.resolve(__dirname, "../../../internal-packages/dashboard-agent-db/drizzle");
  const migrations = readdirSync(folder)
    .filter((file) => file.endsWith(".sql"))
    .sort();
  for (const name of migrations) {
    const sql = readFileSync(path.join(folder, name), "utf8");
    for (const statement of sql.split("--> statement-breakpoint")) {
      const trimmed = statement.trim();
      if (trimmed.length > 0) await prisma.$executeRawUnsafe(trimmed);
    }
  }
}

let agentDbClient: DashboardAgentDbClient | undefined;
let prismaForRaw: PrismaClient | undefined;

async function boot(prisma: PrismaClient, connectionUri: string) {
  await applyAgentSchema(prisma);
  agentDbClient = createDashboardAgentDb(connectionUri, { max: 2 });
  ctx.agentDb = agentDbClient.db;
  prismaForRaw = prisma;
}

afterEach(async () => {
  await agentDbClient?.close();
  agentDbClient = undefined;
});

const PROJECT_REF = "proj_sweep";
const ENV_REF = "env_sweep";

async function seedChat(id: string, options: { deleted?: boolean } = {}) {
  await createChat(ctx.agentDb, {
    id,
    organizationId: "org_sweep",
    userId: "user_sweep",
  });
  if (options.deleted) {
    await prismaForRaw!.$executeRawUnsafe(
      `update trigger_dashboard_agent.chats set deleted_at = now() where id = $1`,
      id
    );
  }
}

/** An open card, exactly as a turn writes one before it has an answer. */
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

/** Create an investigation and force its `updated_at` to simulate age. */
async function seedInvestigation(args: {
  chatId: string;
  state: InvestigationState;
  ageMs?: number;
}): Promise<string> {
  const created = await upsertInvestigationRevision(ctx.agentDb, {
    chatId: args.chatId,
    projectRef: PROJECT_REF,
    environmentRef: ENV_REF,
    state: args.state,
  });
  if (!created.ok) throw new Error("the fixture investigation wasn't created");

  if (args.ageMs !== undefined) {
    await prismaForRaw!.$executeRawUnsafe(
      `update trigger_dashboard_agent.investigations
       set updated_at = now() - ($2 || ' milliseconds')::interval where id = $1`,
      created.id,
      String(args.ageMs)
    );
  }
  return created.id;
}

/** Comfortably past the grace window. */
const STALE_AGE_MS = INVESTIGATION_STALE_MS + 60_000;

describe("the dashboard agent investigation sweep", () => {
  postgresTest(
    "settles a card left in_progress, keeping what was established",
    async ({ prisma, postgresContainer }) => {
      await boot(prisma, postgresContainer.getConnectionUri());
      await seedChat("chat_stale");
      const id = await seedInvestigation({
        chatId: "chat_stale",
        state: openState(),
        ageMs: STALE_AGE_MS,
      });

      const result = await sweepDashboardAgentInvestigations();
      expect(result).toMatchObject({ stale: 1, settled: 1, alreadySettled: 0, failed: 0 });

      const row = await getInvestigation(ctx.agentDb, { id });
      // Still a valid card — the merge can't produce a state the surfaces reject.
      const state = investigationStateSchema.parse(row?.state);
      expect(state.outcome).toBe("inconclusive");
      expect(state.confidence).toBe("low");
      // The same ending the turn-level settle writes, word for word.
      expect(state.headline).toBe(
        `Checking whether the failures share a payload. ${UNSETTLED_INVESTIGATION_NOTE}`
      );
      // Nothing is claimed as done, and nothing established is lost.
      expect(state.progress).toBeUndefined();
      expect(state.remediation).toBeUndefined();
      expect(state.hypotheses).toHaveLength(1);
      expect(state.title).toBe("send-order-receipt keeps failing");
      // A revision, like every other write to the card.
      expect(row?.revision).toBe(1);
    }
  );

  postgresTest(
    "drops a fix a concluded card was carrying",
    async ({ prisma, postgresContainer }) => {
      await boot(prisma, postgresContainer.getConnectionUri());
      await seedChat("chat_fix");
      // An in_progress card should never carry remediation, but if one does the
      // settle must strip it — an inconclusive card may not offer a fix.
      const id = await seedInvestigation({
        chatId: "chat_fix",
        state: { ...openState(), remediation: "Raise the timeout." } as InvestigationState,
        ageMs: STALE_AGE_MS,
      });

      await sweepDashboardAgentInvestigations();

      const row = await getInvestigation(ctx.agentDb, { id });
      expect(investigationStateSchema.parse(row?.state).remediation).toBeUndefined();
    }
  );

  postgresTest(
    "leaves a fresh in_progress card alone — a live turn is never swept",
    async ({ prisma, postgresContainer }) => {
      await boot(prisma, postgresContainer.getConnectionUri());
      await seedChat("chat_fresh");
      const id = await seedInvestigation({ chatId: "chat_fresh", state: openState() });

      expect(await sweepDashboardAgentInvestigations()).toMatchObject({ stale: 0, settled: 0 });
      const row = await getInvestigation(ctx.agentDb, { id });
      expect(investigationStateSchema.parse(row?.state).outcome).toBe("in_progress");
      expect(row?.revision).toBe(0);
    }
  );

  postgresTest(
    "leaves a card that already has an answer alone",
    async ({ prisma, postgresContainer }) => {
      await boot(prisma, postgresContainer.getConnectionUri());
      await seedChat("chat_done");
      const id = await seedInvestigation({
        chatId: "chat_done",
        state: openState({
          outcome: "inconclusive",
          progress: undefined,
          headline: "Not established: the failures span two versions.",
        }),
        ageMs: STALE_AGE_MS,
      });

      expect(await sweepDashboardAgentInvestigations()).toMatchObject({ stale: 0, settled: 0 });
      const row = await getInvestigation(ctx.agentDb, { id });
      // Untouched: no second revision, and no note appended to the real answer.
      expect(row?.revision).toBe(0);
      expect(investigationStateSchema.parse(row?.state).headline).toBe(
        "Not established: the failures span two versions."
      );
    }
  );

  postgresTest("skips a card in a deleted chat", async ({ prisma, postgresContainer }) => {
    await boot(prisma, postgresContainer.getConnectionUri());
    await seedChat("chat_gone", { deleted: true });
    await seedInvestigation({
      chatId: "chat_gone",
      state: openState(),
      ageMs: STALE_AGE_MS,
    });

    expect(await sweepDashboardAgentInvestigations()).toMatchObject({ stale: 0, settled: 0 });
  });

  postgresTest(
    "a turn that concludes the card first wins: the settle is a no-op, not an error",
    async ({ prisma, postgresContainer }) => {
      await boot(prisma, postgresContainer.getConnectionUri());
      await seedChat("chat_race");
      const id = await seedInvestigation({
        chatId: "chat_race",
        state: openState(),
        ageMs: STALE_AGE_MS,
      });

      const stale = await listStaleOpenInvestigations(ctx.agentDb, {
        olderThan: new Date(),
        limit: 10,
      });
      expect(stale.map((row) => row.id)).toEqual([id]);

      // The turn comes back between the list and the write, with a real answer.
      const concluded = await upsertInvestigationRevision(ctx.agentDb, {
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

      // The sweep still has the pre-conclusion rows in hand.
      const result = await sweepDashboardAgentInvestigations({ listStale: async () => stale });
      expect(result).toMatchObject({ stale: 1, settled: 0, alreadySettled: 1, failed: 0 });

      // The answer stands, unedited.
      const row = await getInvestigation(ctx.agentDb, { id });
      const state = investigationStateSchema.parse(row?.state);
      expect(state.outcome).toBe("concluded");
      expect(state.headline).not.toContain(UNSETTLED_INVESTIGATION_NOTE);
      expect(row?.revision).toBe(1);
    }
  );

  postgresTest(
    "one failing row doesn't cost the batch, and the run throws so the job retries",
    async ({ prisma, postgresContainer }) => {
      await boot(prisma, postgresContainer.getConnectionUri());
      await seedChat("chat_batch");
      const first = await seedInvestigation({
        chatId: "chat_batch",
        state: openState(),
        ageMs: STALE_AGE_MS + 60_000,
      });
      const second = await seedInvestigation({
        chatId: "chat_batch",
        state: openState(),
        ageMs: STALE_AGE_MS,
      });

      const attempted: string[] = [];
      await expect(
        sweepDashboardAgentInvestigations({
          settle: async (params) => {
            attempted.push(params.id);
            if (params.id === first) throw new Error("the settle failed");
            return settleInvestigationAsInconclusive(ctx.agentDb, params);
          },
        })
      ).rejects.toThrow(/failed on 1 investigations/);

      // Oldest first, and the failure didn't stop the one behind it.
      expect(attempted).toEqual([first, second]);
      expect(
        investigationStateSchema.parse((await getInvestigation(ctx.agentDb, { id: second }))?.state)
          .outcome
      ).toBe("inconclusive");
      // The failed one is left exactly as it was, for the next sweep.
      const stuck = await getInvestigation(ctx.agentDb, { id: first });
      expect(stuck?.revision).toBe(0);
      expect(investigationStateSchema.parse(stuck?.state).outcome).toBe("in_progress");
    }
  );
});
