import {
  appendChatMessageOnce,
  countUserMessages,
  getWatch,
  getWatchSubmission,
  listActiveWatchesForChat,
  recordWatchSubmissionOutcome,
  transitionWatchCondition,
  type DashboardAgentDb,
} from "@internal/dashboard-agent-db";
import type { WatchDraft } from "@internal/dashboard-agent-contracts";
import { postgresTest } from "@internal/testcontainers";
import type { PrismaClient } from "@trigger.dev/database";
import { afterEach, beforeEach, describe, expect, vi } from "vitest";
import type { WatchCheckDeps } from "~/services/dashboardAgentWatchChecks";
import {
  DashboardAgentWatchesTestHarness,
  RUN_START,
  draftFor,
  type DashboardAgentWatchesTestContext,
  type Seeded,
} from "./helpers/dashboardAgentWatchesTestHelpers";

vi.setConfig({ testTimeout: 60_000 });

const ctx = vi.hoisted(
  (): DashboardAgentWatchesTestContext => ({
    prisma: undefined as unknown as PrismaClient,
    agentDb: undefined as unknown as DashboardAgentDb,
    canAccess: true,
    actor: undefined,
    triggered: [],
  })
);

vi.mock("~/db.server", () => {
  const proxy = new Proxy(
    {},
    { get: (_target, prop) => (ctx.prisma as unknown as Record<string, unknown>)[prop as string] }
  );
  return { prisma: proxy, $replica: proxy, sqlDatabaseSchema: undefined };
});

vi.mock("~/services/dashboardAgentDb.server", () => ({
  get dashboardAgentDb() {
    return ctx.agentDb;
  },
}));

process.env.SESSION_SECRET = "test-session-secret-for-watch-tokens";
process.env.ALERT_FROM_EMAIL = "alerts@example.com";
process.env.ALERT_EMAIL_TRANSPORT = "smtp";

const { createDashboardAgentWatch, submitDashboardAgentWatch } =
  await import("~/services/dashboardAgentWatches.server");
const { subscribeUserToWatchAlerts } = await import("~/services/dashboardAgentWatchAlerts.server");

const harness = new DashboardAgentWatchesTestHarness(ctx, createDashboardAgentWatch);
const boot = harness.boot.bind(harness);
const seed = harness.seed.bind(harness);
const authenticated = harness.authenticated.bind(harness);
const seedChat = harness.seedChat.bind(harness);
const runRow = harness.runRow.bind(harness);
const fakeCheckDeps = harness.fakeCheckDeps.bind(harness);
const create = harness.create.bind(harness);
const storedMessages = harness.storedMessages.bind(harness);

beforeEach(() => harness.reset());
afterEach(() => harness.close());

function submit(args: {
  seeded: Seeded;
  draft?: WatchDraft;
  chatId?: string;
  clientRequestId?: string;
  checkDeps?: Partial<WatchCheckDeps>;
  subscribed?: boolean;
  /** Replaces the fake outright, so a test can hand the submit the real subscribe. */
  subscribe?: typeof subscribeUserToWatchAlerts;
  onSchedule?: () => void;
  /** Wraps the creation step, so a test can die at the exact point after it. */
  create?: typeof createDashboardAgentWatch;
}) {
  return submitDashboardAgentWatch({
    environment: authenticated(args.seeded),
    userId: args.seeded.user.id,
    organizationId: args.seeded.organization.id,
    chatId: args.chatId,
    clientRequestId: args.clientRequestId ?? "wreq_1",
    draft: args.draft ?? draftFor(RUN_START),
    deps: {
      configured: () => true,
      checkDeps: () => fakeCheckDeps(args.checkDeps),
      scheduleTick: async () => args.onSchedule?.(),
      ...(args.create ? { create: args.create } : {}),
      subscribe:
        args.subscribe ??
        (async () =>
          args.subscribed === false
            ? { ok: false, reason: "dashboard_agent_disabled" }
            : { ok: true, email: args.seeded.user.email }),
    },
  });
}

describe("the watch card submit", () => {
  postgresTest(
    "records what the user confirmed before the watch, and confirms it after",
    async ({ prisma, postgresContainer }) => {
      await boot(prisma, postgresContainer.getConnectionUri());
      const seeded = await seed(prisma, "submit");
      await seedChat(seeded);

      const result = await submit({
        seeded,
        chatId: "chat_1",
        draft: draftFor(RUN_START, { investigateOnAttention: true }),
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.watching).toBe(true);
      expect(result.repaired).toBe(false);

      const stored = await storedMessages(seeded, "chat_1");
      expect(stored?.map((message) => message.id)).toEqual([
        "watch-request:wreq_1",
        `watch-confirmation:${result.watchId}`,
      ]);
      // The consent record is the user's, and it states the condition and the lifetime.
      expect(stored?.[0]).toMatchObject({ role: "user" });
      expect(JSON.stringify(stored?.[0])).toContain("Watch run run_1 until it starts.");
      expect(JSON.stringify(stored?.[0])).toContain("Investigate straight away");
      expect(result.messages.map((message) => message.id)).toEqual(
        stored?.map((message) => message.id)
      );
    }
  );

  postgresTest(
    "leaves a repairable state when the confirmation never lands, and the retry repairs it",
    async ({ prisma, postgresContainer }) => {
      await boot(prisma, postgresContainer.getConnectionUri());
      const seeded = await seed(prisma, "submit-repair");
      await seedChat(seeded);

      // The crash state: the request record is written and the watch is live, but the
      // process died before the confirmation was appended.
      await appendChatMessageOnce(ctx.agentDb, {
        chatId: "chat_1",
        userId: seeded.user.id,
        message: { id: "watch-request:wreq_1", role: "user", parts: [] } as never,
      });
      const created = await create({ seeded, chatId: "chat_1" });
      expect(created.ok).toBe(true);
      if (!created.ok || !created.watching) return;

      const retry = await submit({ seeded, chatId: "chat_1", clientRequestId: "wreq_1" });

      expect(retry.ok).toBe(true);
      if (!retry.ok) return;
      expect(retry.repaired).toBe(true);
      expect(retry.watchId).toBe(created.watchId);

      const stored = await storedMessages(seeded, "chat_1");
      expect(stored?.map((message) => message.id)).toEqual([
        "watch-request:wreq_1",
        `watch-confirmation:${created.watchId}`,
      ]);

      // Still exactly one watch: the repair loaded it rather than creating another.
      const active = await listActiveWatchesForChat(ctx.agentDb, { chatId: "chat_1" });
      expect(active).toHaveLength(1);
    }
  );

  postgresTest(
    "a retried submit duplicates neither record",
    async ({ prisma, postgresContainer }) => {
      await boot(prisma, postgresContainer.getConnectionUri());
      const seeded = await seed(prisma, "submit-retry");
      await seedChat(seeded);

      const first = await submit({ seeded, chatId: "chat_1" });
      const second = await submit({ seeded, chatId: "chat_1" });

      expect(first.ok && second.ok).toBe(true);
      if (!first.ok || !second.ok) return;
      expect(second.repaired).toBe(true);
      expect(second.watchId).toBe(first.watchId);

      const stored = await storedMessages(seeded, "chat_1");
      expect(stored?.map((message) => message.id)).toEqual([
        "watch-request:wreq_1",
        `watch-confirmation:${first.watchId}`,
      ]);
    }
  );

  postgresTest(
    "a genuinely different request still conflicts",
    async ({ prisma, postgresContainer }) => {
      await boot(prisma, postgresContainer.getConnectionUri());
      const seeded = await seed(prisma, "submit-conflict");
      await seedChat(seeded);

      const first = await submit({ seeded, chatId: "chat_1" });
      expect(first.ok).toBe(true);
      if (!first.ok) return;

      // Same condition, so the same identity, but a different window: not a retry.
      const longer = await submit({
        seeded,
        chatId: "chat_1",
        clientRequestId: "wreq_2",
        draft: draftFor({ ...RUN_START, maxHours: 6 }),
      });
      expect(longer).toMatchObject({ ok: false, code: "duplicate", existingId: first.watchId });

      // Same spec, different consent: also not a retry.
      const investigating = await submit({
        seeded,
        chatId: "chat_1",
        clientRequestId: "wreq_3",
        draft: draftFor(RUN_START, { investigateOnAttention: true }),
      });
      expect(investigating).toMatchObject({ ok: false, code: "duplicate" });

      // The refused attempts are recorded under their own consent records, so the
      // transcript never shows a request with no answer.
      const stored = await storedMessages(seeded, "chat_1");
      expect(stored?.map((message) => message.id)).toEqual([
        "watch-request:wreq_1",
        `watch-confirmation:${first.watchId}`,
        "watch-request:wreq_2",
        "watch-confirmation:refused:wreq_2",
        "watch-request:wreq_3",
        "watch-confirmation:refused:wreq_3",
      ]);
    }
  );

  postgresTest(
    "a fresh panel's retry reuses the chat the first attempt created",
    async ({ prisma, postgresContainer }) => {
      await boot(prisma, postgresContainer.getConnectionUri());
      const seeded = await seed(prisma, "submit-fresh");

      const first = await submit({ seeded, clientRequestId: "wreq_fresh" });
      const second = await submit({ seeded, clientRequestId: "wreq_fresh" });

      expect(first.ok && second.ok).toBe(true);
      if (!first.ok || !second.ok) return;
      expect(second.chatId).toBe(first.chatId);

      const stored = await storedMessages(seeded, first.chatId);
      expect(stored).toHaveLength(2);
    }
  );

  postgresTest(
    "an answered condition records the request and a one-shot result, and never a watch",
    async ({ prisma, postgresContainer }) => {
      await boot(prisma, postgresContainer.getConnectionUri());
      const seeded = await seed(prisma, "submit-oneshot");
      await seedChat(seeded);

      const result = await submit({
        seeded,
        chatId: "chat_1",
        checkDeps: { readRun: async () => runRow({ status: "EXECUTING", startedAt: new Date() }) },
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.watching).toBe(false);
      expect(result.watchId).toBeNull();

      const stored = await storedMessages(seeded, "chat_1");
      expect(stored?.map((message) => message.id)).toEqual([
        "watch-request:wreq_1",
        "watch-confirmation:one-shot:wreq_1",
      ]);
      expect(await listActiveWatchesForChat(ctx.agentDb, { chatId: "chat_1" })).toHaveLength(0);
    }
  );

  /** Every watch row for a chat, terminal ones included. `listActiveWatchesForChat` can't see those. */
  async function countWatchRows(prisma: PrismaClient, chatId: string) {
    const rows = await prisma.$queryRawUnsafe<Array<{ count: bigint }>>(
      `select count(*)::bigint as count from trigger_dashboard_agent.watches where chat_id = $1`,
      chatId
    );
    return Number(rows[0]?.count ?? 0);
  }

  postgresTest(
    "a retry after the watch has already fired creates no second watch",
    async ({ prisma, postgresContainer }) => {
      await boot(prisma, postgresContainer.getConnectionUri());
      const seeded = await seed(prisma, "submit-fired");
      await seedChat(seeded);

      const first = await submit({ seeded, chatId: "chat_1" });
      expect(first.ok).toBe(true);
      if (!first.ok || !first.watchId) return;

      // The watch resolves and leaves the active set, so a duplicate check would find
      // nothing. Only the ledger still knows this request already ran.
      await transitionWatchCondition(ctx.agentDb, {
        id: first.watchId,
        resolution: "condition_met",
      });

      const retry = await submit({ seeded, chatId: "chat_1" });

      expect(retry.ok).toBe(true);
      if (!retry.ok) return;
      expect(retry.repaired).toBe(true);
      expect(retry.watchId).toBe(first.watchId);
      expect(await countWatchRows(prisma, "chat_1")).toBe(1);

      const stored = await storedMessages(seeded, "chat_1");
      expect(stored?.map((message) => message.id)).toEqual([
        "watch-request:wreq_1",
        `watch-confirmation:${first.watchId}`,
      ]);
    }
  );

  postgresTest(
    "a retry of an answered one-shot never becomes a watch",
    async ({ prisma, postgresContainer }) => {
      await boot(prisma, postgresContainer.getConnectionUri());
      const seeded = await seed(prisma, "submit-oneshot-retry");
      await seedChat(seeded);

      const first = await submit({
        seeded,
        chatId: "chat_1",
        checkDeps: { readRun: async () => runRow({ status: "EXECUTING", startedAt: new Date() }) },
      });
      expect(first.ok && first.watching === false).toBe(true);

      // The world moved on: the same condition would now be pending, so a re-evaluation
      // would start a real watch. The recorded outcome is replayed instead.
      const retry = await submit({ seeded, chatId: "chat_1" });

      expect(retry.ok).toBe(true);
      if (!retry.ok) return;
      expect(retry.watching).toBe(false);
      expect(retry.watchId).toBeNull();
      expect(retry.repaired).toBe(true);
      expect(await countWatchRows(prisma, "chat_1")).toBe(0);

      const stored = await storedMessages(seeded, "chat_1");
      expect(stored?.map((message) => message.id)).toEqual([
        "watch-request:wreq_1",
        "watch-confirmation:one-shot:wreq_1",
      ]);
    }
  );

  postgresTest(
    "the same request id carrying a different draft is a conflict",
    async ({ prisma, postgresContainer }) => {
      await boot(prisma, postgresContainer.getConnectionUri());
      const seeded = await seed(prisma, "submit-hash");
      await seedChat(seeded);

      const first = await submit({ seeded, chatId: "chat_1" });
      expect(first.ok).toBe(true);
      if (!first.ok) return;

      const changed = await submit({
        seeded,
        chatId: "chat_1",
        draft: draftFor({ ...RUN_START, maxHours: 6 }),
      });
      expect(changed).toMatchObject({ ok: false, code: "request_conflict" });

      // A conflict writes nothing at all: no watch, and no record under the request.
      expect(await countWatchRows(prisma, "chat_1")).toBe(1);
      const stored = await storedMessages(seeded, "chat_1");
      expect(stored?.map((message) => message.id)).toEqual([
        "watch-request:wreq_1",
        `watch-confirmation:${first.watchId}`,
      ]);
    }
  );

  postgresTest(
    "a pending submission converges on the watch its first attempt created",
    async ({ prisma, postgresContainer }) => {
      await boot(prisma, postgresContainer.getConnectionUri());
      const seeded = await seed(prisma, "submit-converge");
      await seedChat(seeded);

      // The crash state the ledger exists for: the row is reserved, the watch is live
      // under the reserved id, and the process died before the outcome was written.
      let reservedWatchId = "";
      await expect(
        submit({
          seeded,
          chatId: "chat_1",
          create: async (createParams) => {
            reservedWatchId = createParams.watchId!;
            await createDashboardAgentWatch(createParams);
            throw new Error("died after the watch was created");
          },
        })
      ).rejects.toThrow("died after the watch was created");

      const pending = await getWatchSubmission(ctx.agentDb, {
        chatId: "chat_1",
        clientRequestId: "wreq_1",
      });
      expect(pending).toMatchObject({ state: "pending", watchId: reservedWatchId });

      const retry = await submit({ seeded, chatId: "chat_1" });

      expect(retry.ok).toBe(true);
      if (!retry.ok) return;
      // Reached the reserved row rather than creating another.
      expect(retry.watchId).toBe(reservedWatchId);
      expect(await countWatchRows(prisma, "chat_1")).toBe(1);

      const settled = await getWatchSubmission(ctx.agentDb, {
        chatId: "chat_1",
        clientRequestId: "wreq_1",
      });
      expect(settled).toMatchObject({ state: "created", watchId: reservedWatchId });
    }
  );

  postgresTest(
    "converging on a watch that already fired confirms the outcome, not 'watching'",
    async ({ prisma, postgresContainer }) => {
      await boot(prisma, postgresContainer.getConnectionUri());
      const seeded = await seed(prisma, "submit-converge-fired");
      await seedChat(seeded);

      let reservedWatchId = "";
      await expect(
        submit({
          seeded,
          chatId: "chat_1",
          create: async (createParams) => {
            reservedWatchId = createParams.watchId!;
            await createDashboardAgentWatch(createParams);
            throw new Error("died after the watch was created");
          },
        })
      ).rejects.toThrow("died after the watch was created");

      // The watch ran and woke the chat before anyone retried the submit.
      await transitionWatchCondition(ctx.agentDb, {
        id: reservedWatchId,
        resolution: "condition_met",
        observedOutcome: { kind: "run_start", verified: true, status: "EXECUTING", started: true },
      });

      const retry = await submit({ seeded, chatId: "chat_1" });

      expect(retry.ok).toBe(true);
      if (!retry.ok) return;
      // Still one row, still the same watch: adoption is not refused.
      expect(retry.watchId).toBe(reservedWatchId);
      expect(await countWatchRows(prisma, "chat_1")).toBe(1);

      const parts = retry.messages.at(-1)?.parts ?? [];
      const block = (parts[0] as any).data.blocks[0];
      expect(block.outcome).toBe("already_true");
      expect(block.headline).not.toContain("Watching");
      expect(block.lifetime).toBeNull();
    }
  );

  postgresTest(
    "a refusal that wins the race leaves no live watch behind",
    async ({ prisma, postgresContainer }) => {
      await boot(prisma, postgresContainer.getConnectionUri());
      const seeded = await seed(prisma, "submit-refused-race");
      await seedChat(seeded);

      // A concurrent attempt refuses this submission after the watch exists under the
      // reserved id, so the ledger's winner keeps naming that id.
      let reservedWatchId = "";
      const result = await submit({
        seeded,
        chatId: "chat_1",
        create: async (createParams) => {
          reservedWatchId = createParams.watchId!;
          const created = await createDashboardAgentWatch(createParams);
          const refused = await recordWatchSubmissionOutcome(ctx.agentDb, {
            chatId: "chat_1",
            clientRequestId: "wreq_1",
            state: "refused",
            refusalCode: "internal",
            refusalError: "That watch couldn't be started.",
          });
          expect(refused).toMatchObject({ state: "refused", watchId: reservedWatchId });
          return created;
        },
      });

      // The user is told nothing is being watched, so nothing may be watching.
      expect(result.ok).toBe(false);
      const row = await getWatch(ctx.agentDb, { id: reservedWatchId });
      expect(row).toMatchObject({ status: "cancelled", cancelReason: "superseded" });
    }
  );

  postgresTest(
    "the consent record never spends a message from the cap",
    async ({ prisma, postgresContainer }) => {
      await boot(prisma, postgresContainer.getConnectionUri());
      const seeded = await seed(prisma, "submit-quota");
      await seedChat(seeded);

      await submit({ seeded, chatId: "chat_1" });

      expect(
        await countUserMessages(ctx.agentDb, {
          organizationId: seeded.organization.id,
          userId: seeded.user.id,
        })
      ).toBe(0);
    }
  );

  postgresTest(
    "a replay repeats the recorded email outcome and subscribes nobody",
    async ({ prisma, postgresContainer }) => {
      await boot(prisma, postgresContainer.getConnectionUri());
      const seeded = await seed(prisma, "submit-external-replay");
      await seedChat(seeded);

      const draft = draftFor(RUN_START, { notifyExternally: true });

      // The first attempt asked for email and couldn't get it, so `unavailable` is what
      // the transcript says and what the ledger records.
      const first = await submit({ seeded, chatId: "chat_1", draft, subscribed: false });
      expect(first.ok).toBe(true);
      if (!first.ok) return;
      expect(JSON.stringify(first.messages)).toContain("I couldn't add email notifications");
      expect(
        await getWatchSubmission(ctx.agentDb, { chatId: "chat_1", clientRequestId: "wreq_1" })
      ).toMatchObject({ state: "created", externalNotificationStatus: "unavailable" });

      const transcript = await storedMessages(seeded, "chat_1");

      // The retry gets the real subscribe, which would succeed here. A replay that took the
      // decision again would leave a channel row and an `enabled` answer the transcript —
      // append-once, so never rewritten — contradicts for good.
      let subscribeCalls = 0;
      const retry = await submit({
        seeded,
        chatId: "chat_1",
        draft,
        subscribe: async (subscribeParams) => {
          subscribeCalls++;
          return subscribeUserToWatchAlerts(subscribeParams);
        },
      });

      expect(retry.ok).toBe(true);
      if (!retry.ok) return;
      expect(retry.repaired).toBe(true);
      expect(retry.watchId).toBe(first.watchId);
      expect(subscribeCalls).toBe(0);

      expect(JSON.stringify(retry.messages)).toContain("I couldn't add email notifications");
      expect(JSON.stringify(retry.messages)).not.toContain("You'll get an email");
      expect(
        await prisma.projectAlertChannel.count({ where: { projectId: seeded.project.id } })
      ).toBe(0);
      expect(
        await getWatchSubmission(ctx.agentDb, { chatId: "chat_1", clientRequestId: "wreq_1" })
      ).toMatchObject({ externalNotificationStatus: "unavailable" });

      // The symptom: what the user is told after a refresh has to agree with the answer.
      expect(await storedMessages(seeded, "chat_1")).toEqual(transcript);
    }
  );

  postgresTest(
    "a replay repeats the recorded 'Watching' confirmation after the watch has fired",
    async ({ prisma, postgresContainer }) => {
      await boot(prisma, postgresContainer.getConnectionUri());
      const seeded = await seed(prisma, "submit-replay-fired");
      await seedChat(seeded);

      const first = await submit({ seeded, chatId: "chat_1" });
      expect(first.ok).toBe(true);
      if (!first.ok || !first.watchId) return;

      await transitionWatchCondition(ctx.agentDb, {
        id: first.watchId,
        resolution: "condition_met",
      });

      const retry = await submit({ seeded, chatId: "chat_1" });

      expect(retry.ok).toBe(true);
      if (!retry.ok) return;
      expect(retry.repaired).toBe(true);

      // The recorded outcome is replayed, never decided again: the append-once
      // confirmation in the transcript says "Watching", so the answer has to as well.
      const parts = retry.messages.at(-1)?.parts ?? [];
      const block = (parts[0] as any).data.blocks[0];
      expect(block.outcome).toBe("watching");
      expect(block.headline).toContain("Watching");
    }
  );
});
