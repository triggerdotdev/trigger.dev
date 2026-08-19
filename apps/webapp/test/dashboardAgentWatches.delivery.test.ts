import {
  appendChatMessageOnce,
  cancelWatch,
  chatExists,
  claimWatchDelivery,
  claimWatchTick,
  countUnreadWatchWakes,
  countUserMessages,
  getChatMessages,
  getWatch,
  getWatchSubmission,
  listActiveWatchesForChat,
  listChatIdsWithUnreadWakes,
  listRecentWatchWakes,
  markWatchDelivered,
  readWatchWakeFeed,
  recordWatchCheck,
  recordWatchSubmissionOutcome,
  releaseWatchDelivery,
  transitionWatchCondition,
  WATCH_DELIVERY_CLAIM_STALE_MS,
  type DashboardAgentDb,
  type Watch,
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

const {
  cancelDashboardAgentWatch,
  createDashboardAgentWatch,
  deleteChatWithWatches,
  listActiveWatchesForChats,
  submitDashboardAgentWatch,
} = await import("~/services/dashboardAgentWatches.server");
const { sweepDashboardAgentWatches, WATCH_DELIVERY_GRACE_MS, WATCH_EXPIRY_GRACE_MS } =
  await import("~/services/dashboardAgentWatchSweep.server");
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

describe("the chat cascade and the list view", () => {
  postgresTest(
    "deleting a chat soft-deletes it and cancels its active watches in one call",
    async ({ prisma, postgresContainer }) => {
      await boot(prisma, postgresContainer.getConnectionUri());
      const seeded = await seed(prisma, "cascade");
      await seedChat(seeded, "chat_1");
      await seedChat(seeded, "chat_2");

      const mine = await create({ seeded, chatId: "chat_1" });
      const theirs = await create({ seeded, chatId: "chat_2" });
      expect(mine.ok && theirs.ok).toBe(true);
      if (!mine.ok || !theirs.ok) return;

      expect(
        await deleteChatWithWatches({
          chatId: "chat_1",
          userId: seeded.user.id,
          organizationId: seeded.organization.id,
        })
      ).toEqual({
        deleted: true,
        cancelledWatches: 1,
      });

      expect(
        await chatExists(ctx.agentDb, {
          chatId: "chat_1",
          userId: seeded.user.id,
          organizationId: seeded.organization.id,
        })
      ).toBe(false);
      expect(await getWatch(ctx.agentDb, { id: mine.watchId })).toMatchObject({
        status: "cancelled",
        cancelReason: "chat_deleted",
        deliveryStatus: "not_required",
      });
      expect(await getWatch(ctx.agentDb, { id: theirs.watchId })).toMatchObject({
        status: "active",
      });
    }
  );

  postgresTest(
    "a user's own cancel leaves one neutral line in the chat, and only one",
    async ({ prisma, postgresContainer }) => {
      await boot(prisma, postgresContainer.getConnectionUri());
      const seeded = await seed(prisma, "usercancel");
      await seedChat(seeded, "chat_1");

      const created = await create({ seeded, chatId: "chat_1" });
      expect(created.ok).toBe(true);
      if (!created.ok) return;

      const cancel = () =>
        cancelDashboardAgentWatch({
          watchId: created.watchId,
          userId: seeded.user.id,
          organizationId: seeded.organization.id,
        });

      expect(await cancel()).toMatchObject({
        cancelled: true,
        messages: [
          {
            id: `watch-cancelled:${created.watchId}`,
            role: "assistant",
            parts: [{ type: "text", text: "Stopped watching run run_1." }],
          },
        ],
      });
      expect(await getWatch(ctx.agentDb, { id: created.watchId })).toMatchObject({
        status: "cancelled",
        cancelReason: "user",
        deliveryStatus: "not_required",
      });
      expect(await storedMessages(seeded, "chat_1")).toMatchObject([
        { id: `watch-cancelled:${created.watchId}`, role: "assistant" },
      ]);

      // The row is no longer active, so the second cancel writes nothing at all.
      expect(await cancel()).toEqual({ cancelled: false, messages: [] });
      expect(await storedMessages(seeded, "chat_1")).toHaveLength(1);
    }
  );

  postgresTest(
    "a chat delete cancels its watches without a line in the chat",
    async ({ prisma, postgresContainer }) => {
      await boot(prisma, postgresContainer.getConnectionUri());
      const seeded = await seed(prisma, "silentcancel");
      await seedChat(seeded, "chat_1");

      const created = await create({ seeded, chatId: "chat_1" });
      expect(created.ok).toBe(true);

      await deleteChatWithWatches({
        chatId: "chat_1",
        userId: seeded.user.id,
        organizationId: seeded.organization.id,
      });

      const rows = await ctx.prisma.$queryRawUnsafe<{ message_id: string }[]>(
        `select message_id from trigger_dashboard_agent.chat_messages where chat_id = 'chat_1'`
      );
      expect(rows).toEqual([]);
    }
  );

  postgresTest(
    "aggregates active watches per chat in one query",
    async ({ prisma, postgresContainer }) => {
      await boot(prisma, postgresContainer.getConnectionUri());
      const seeded = await seed(prisma, "chips");
      await seedChat(seeded, "chat_1");
      await seedChat(seeded, "chat_2");

      const a = await create({ seeded, chatId: "chat_1", spec: { ...RUN_START, runId: "run_1" } });
      const b = await create({ seeded, chatId: "chat_1", spec: { ...RUN_START, runId: "run_2" } });
      const c = await create({ seeded, chatId: "chat_2" });
      expect(a.ok && b.ok && c.ok).toBe(true);

      const byChat = await listActiveWatchesForChats({
        chatIds: ["chat_1", "chat_2", "chat_missing"],
        organizationId: seeded.organization.id,
        userId: seeded.user.id,
      });
      expect(byChat.chat_1).toHaveLength(2);
      expect(byChat.chat_2).toHaveLength(1);
      expect(byChat.chat_missing).toBeUndefined();
      expect(byChat.chat_2![0]).toMatchObject({
        identity: "run_start:run_1",
        status: "active",
        kind: "run_start",
        note: RUN_START.note,
      });

      if (a.ok) await cancelWatch(ctx.agentDb, { id: a.watchId, reason: "user" });
      if (b.ok) await cancelWatch(ctx.agentDb, { id: b.watchId, reason: "user" });
      expect(
        (
          await listActiveWatchesForChats({
            chatIds: ["chat_1"],
            organizationId: seeded.organization.id,
            userId: seeded.user.id,
          })
        ).chat_1
      ).toBeUndefined();
    }
  );

  postgresTest("returns nothing for an empty chat list", async ({ prisma, postgresContainer }) => {
    await boot(prisma, postgresContainer.getConnectionUri());
    expect(
      await listActiveWatchesForChats({ chatIds: [], organizationId: "org_x", userId: "user_x" })
    ).toEqual({});
  });
});

describe("unread watch wakes", () => {
  postgresTest(
    "only signals a wake once its delivery landed",
    async ({ prisma, postgresContainer }) => {
      await boot(prisma, postgresContainer.getConnectionUri());
      const seeded = await seed(prisma, "unread");
      await seedChat(seeded, "chat_1");

      const created = await create({ seeded, chatId: "chat_1" });
      expect(created.ok).toBe(true);
      if (!created.ok) return;

      const scope = { organizationId: seeded.organization.id, userId: seeded.user.id };
      const recent = { ...scope, deliveredAfter: new Date(Date.now() - 15 * 60 * 1000) };

      if (!created.watching) throw new Error("expected a watch");
      await transitionWatchCondition(ctx.agentDb, {
        id: created.watchId,
        resolution: "condition_met",
      });
      expect(await countUnreadWatchWakes(ctx.agentDb, scope)).toBe(0);
      expect(await listRecentWatchWakes(ctx.agentDb, recent)).toEqual([]);
      expect(await listChatIdsWithUnreadWakes(ctx.agentDb, scope)).toEqual(new Set());

      await markWatchDelivered(ctx.agentDb, { id: created.watchId });
      expect(await countUnreadWatchWakes(ctx.agentDb, scope)).toBe(1);
      expect(await listRecentWatchWakes(ctx.agentDb, recent)).toMatchObject([
        { watchId: created.watchId, chatId: "chat_1", outcome: "fired", unread: true },
      ]);
      expect(await listChatIdsWithUnreadWakes(ctx.agentDb, scope)).toEqual(new Set(["chat_1"]));

      // The poll's single query answers both halves the same way.
      expect(await readWatchWakeFeed(ctx.agentDb, recent)).toMatchObject({
        unreadWakes: 1,
        wakes: [{ watchId: created.watchId, chatId: "chat_1", outcome: "fired", unread: true }],
      });

      // An unread wake from before the window still counts, but isn't narrated again.
      expect(
        await readWatchWakeFeed(ctx.agentDb, {
          ...scope,
          deliveredAfter: new Date(Date.now() + 60_000),
        })
      ).toMatchObject({ unreadWakes: 1, wakes: [] });
    }
  );
});

describe("the watch sweep", () => {
  async function overdueWatch(seeded: Seeded, chatId = "chat_1") {
    const created = await create({ seeded, chatId });
    if (!created.ok) throw new Error("the watch wasn't created");
    await ctx.prisma.$executeRawUnsafe(
      `update trigger_dashboard_agent.watches set expires_at = now() - interval '1 hour' where id = $1`,
      created.watchId
    );
    return created.watchId;
  }

  function sweepDeps(args: {
    seeded: Seeded;
    checkDeps?: Partial<WatchCheckDeps>;
    revoked?: boolean;
    now?: Date;
    failDelivery?: boolean;
    delivered: string[];
  }) {
    return {
      now: () => args.now ?? new Date(),
      checkDeps: () => fakeCheckDeps(args.checkDeps),
      authorize: async () =>
        args.revoked
          ? ({ ok: false, reason: "access_revoked" } as const)
          : ({ ok: true, environment: authenticated(args.seeded) } as const),
      deliver: async (watch: Watch) => {
        if (args.failDelivery) throw new Error("the delivery couldn't be scheduled");
        args.delivered.push(watch.id);
      },
      configured: () => true,
    };
  }

  postgresTest(
    "runs the final check on an overdue watch and fires it at the buzzer",
    async ({ prisma, postgresContainer }) => {
      await boot(prisma, postgresContainer.getConnectionUri());
      const seeded = await seed(prisma, "sweep");
      await seedChat(seeded);
      const watchId = await overdueWatch(seeded);

      const delivered: string[] = [];
      const result = await sweepDashboardAgentWatches(
        sweepDeps({
          seeded,
          delivered,
          checkDeps: {
            readRun: async () => runRow({ status: "EXECUTING", startedAt: new Date() }),
          },
        })
      );

      expect(result).toMatchObject({ overdue: 1, fired: 1, expired: 0, cancelled: 0, failed: 0 });
      expect(await getWatch(ctx.agentDb, { id: watchId })).toMatchObject({
        status: "fired",
        deliveryStatus: "pending",
      });
      expect(delivered).toEqual([watchId]);
    }
  );

  postgresTest(
    "expires an overdue watch the check says hasn't happened, as verified",
    async ({ prisma, postgresContainer }) => {
      await boot(prisma, postgresContainer.getConnectionUri());
      const seeded = await seed(prisma, "sweep");
      await seedChat(seeded);
      const watchId = await overdueWatch(seeded);

      const delivered: string[] = [];
      const result = await sweepDashboardAgentWatches(sweepDeps({ seeded, delivered }));

      expect(result).toMatchObject({ overdue: 1, expired: 1, failed: 0 });
      const row = await getWatch(ctx.agentDb, { id: watchId });
      expect(row).toMatchObject({ status: "expired", deliveryStatus: "pending" });
      expect(row?.lastResult).toMatchObject({ verified: true, reason: "not_met_by_expiry" });
      expect(delivered).toEqual([watchId]);
    }
  );

  postgresTest(
    "cancels an overdue watch whose user lost access, and never wakes the chat",
    async ({ prisma, postgresContainer }) => {
      await boot(prisma, postgresContainer.getConnectionUri());
      const seeded = await seed(prisma, "sweep");
      await seedChat(seeded);
      const watchId = await overdueWatch(seeded);

      const delivered: string[] = [];
      const result = await sweepDashboardAgentWatches(
        sweepDeps({ seeded, delivered, revoked: true })
      );

      expect(result).toMatchObject({ overdue: 1, cancelled: 1, expired: 0, fired: 0, failed: 0 });
      expect(await getWatch(ctx.agentDb, { id: watchId })).toMatchObject({
        status: "cancelled",
        cancelReason: "access_revoked",
        deliveryStatus: "not_required",
      });
      expect(delivered).toEqual([]);
    }
  );

  postgresTest(
    "leaves a watch that is still inside its deadline alone",
    async ({ prisma, postgresContainer }) => {
      await boot(prisma, postgresContainer.getConnectionUri());
      const seeded = await seed(prisma, "sweep");
      await seedChat(seeded);
      const created = await create({ seeded });
      expect(created.ok).toBe(true);

      const delivered: string[] = [];
      const result = await sweepDashboardAgentWatches(sweepDeps({ seeded, delivered }));

      expect(result).toMatchObject({ overdue: 0, undelivered: 0 });
      expect(delivered).toEqual([]);
    }
  );

  postgresTest(
    "recovers a wake the delivery lost, through the real query, exactly once",
    async ({ prisma, postgresContainer }) => {
      await boot(prisma, postgresContainer.getConnectionUri());
      const seeded = await seed(prisma, "sweep");
      await seedChat(seeded);
      const watchId = await overdueWatch(seeded);

      const delivered: string[] = [];
      await expect(
        sweepDashboardAgentWatches(sweepDeps({ seeded, delivered, failDelivery: true }))
      ).rejects.toThrow(/failed on 1 watches/);
      expect(await getWatch(ctx.agentDb, { id: watchId })).toMatchObject({
        status: "expired",
        deliveryStatus: "pending",
      });
      expect(delivered).toEqual([]);

      const later = new Date(Date.now() + WATCH_DELIVERY_GRACE_MS + 60_000);
      const second = await sweepDashboardAgentWatches(sweepDeps({ seeded, delivered, now: later }));
      expect(second).toMatchObject({ undelivered: 1, redelivered: 1, failed: 0 });
      expect(delivered).toEqual([watchId]);

      await markWatchDelivered(ctx.agentDb, { id: watchId });
      const third = await sweepDashboardAgentWatches(sweepDeps({ seeded, delivered, now: later }));
      expect(third).toMatchObject({ undelivered: 0, redelivered: 0 });
      expect(delivered).toEqual([watchId]);
    }
  );

  postgresTest(
    "a deliverer that died mid-delivery is recovered, but a fresh claim is left alone",
    async ({ prisma, postgresContainer }) => {
      await boot(prisma, postgresContainer.getConnectionUri());
      const seeded = await seed(prisma, "sweep");
      await seedChat(seeded);
      const watchId = await overdueWatch(seeded);

      await sweepDashboardAgentWatches(sweepDeps({ seeded, delivered: [] }));

      await ctx.prisma.$executeRawUnsafe(
        `update trigger_dashboard_agent.watches
         set delivery_status = 'delivering',
             delivery_claimed_at = now(),
             last_checked_at = now() - interval '1 hour'
         where id = $1`,
        watchId
      );
      expect(await sweepDashboardAgentWatches(sweepDeps({ seeded, delivered: [] }))).toMatchObject({
        undelivered: 0,
      });

      await ctx.prisma.$executeRawUnsafe(
        `update trigger_dashboard_agent.watches
         set delivery_claimed_at = now() - interval '1 hour' where id = $1`,
        watchId
      );
      const recovered: string[] = [];
      expect(
        await sweepDashboardAgentWatches(sweepDeps({ seeded, delivered: recovered }))
      ).toMatchObject({ undelivered: 1, redelivered: 1, failed: 0 });
      expect(recovered).toEqual([watchId]);
    }
  );

  postgresTest(
    "leaves nothing owed for a request the immediate check already answered",
    async ({ prisma, postgresContainer }) => {
      await boot(prisma, postgresContainer.getConnectionUri());
      const seeded = await seed(prisma, "sweep");
      await seedChat(seeded);

      const created = await create({
        seeded,
        checkDeps: { readRun: async () => runRow({ status: "EXECUTING", startedAt: new Date() }) },
      });
      expect(created.ok).toBe(true);
      if (!created.ok || created.watching) throw new Error("expected a one-shot result");

      const delivered: string[] = [];
      const later = new Date(Date.now() + WATCH_DELIVERY_GRACE_MS + 60_000);
      const result = await sweepDashboardAgentWatches(sweepDeps({ seeded, delivered, now: later }));

      expect(result).toMatchObject({ overdue: 0, undelivered: 0, redelivered: 0 });
      expect(delivered).toEqual([]);
    }
  );

  postgresTest(
    "finalizes overdue watches even with no agent to deliver to, and delivers once it's back",
    async ({ prisma, postgresContainer }) => {
      await boot(prisma, postgresContainer.getConnectionUri());
      const seeded = await seed(prisma, "sweep");
      await seedChat(seeded);
      const watchId = await overdueWatch(seeded);

      const delivered: string[] = [];
      const unconfigured = await sweepDashboardAgentWatches({
        ...sweepDeps({ seeded, delivered }),
        configured: () => false,
      });

      expect(unconfigured).toMatchObject({
        overdue: 1,
        expired: 1,
        deliveryDeferred: 1,
        undelivered: 0,
        redelivered: 0,
        failed: 0,
      });
      expect(delivered).toEqual([]);
      expect(await getWatch(ctx.agentDb, { id: watchId })).toMatchObject({
        status: "expired",
        deliveryStatus: "pending",
      });

      const later = new Date(Date.now() + WATCH_DELIVERY_GRACE_MS + 60_000);
      const restored = await sweepDashboardAgentWatches(
        sweepDeps({ seeded, delivered, now: later })
      );
      expect(restored).toMatchObject({ undelivered: 1, redelivered: 1, failed: 0 });
      expect(delivered).toEqual([watchId]);
    }
  );

  postgresTest(
    "the expiry grace keeps the sweep off a watch the tick chain is still finishing",
    async ({ prisma, postgresContainer }) => {
      await boot(prisma, postgresContainer.getConnectionUri());
      const seeded = await seed(prisma, "sweep");
      await seedChat(seeded);
      const created = await create({ seeded });
      expect(created.ok).toBe(true);
      if (!created.ok) return;

      // A second past the deadline, so the chain's own final check owns this window.
      await ctx.prisma.$executeRawUnsafe(
        `update trigger_dashboard_agent.watches set expires_at = now() - interval '1 second' where id = $1`,
        created.watchId
      );
      const delivered: string[] = [];
      expect(await sweepDashboardAgentWatches(sweepDeps({ seeded, delivered }))).toMatchObject({
        overdue: 0,
      });

      const later = new Date(Date.now() + WATCH_EXPIRY_GRACE_MS + 60_000);
      expect(
        await sweepDashboardAgentWatches(sweepDeps({ seeded, delivered, now: later }))
      ).toMatchObject({ overdue: 1, expired: 1 });
    }
  );
});

describe("the tick claim", () => {
  postgresTest(
    "claiming a generation is not an observation: only a recorded check stamps one",
    async ({ prisma, postgresContainer }) => {
      await boot(prisma, postgresContainer.getConnectionUri());
      const seeded = await seed(prisma, "claim");
      await seedChat(seeded);
      const created = await create({ seeded });
      expect(created.ok).toBe(true);
      if (!created.ok) return;

      const claimed = await claimWatchTick(ctx.agentDb, { id: created.watchId, generation: 1 });
      expect(claimed).toMatchObject({ tickCount: 1, lastCheckedAt: null, lastResult: null });

      await recordWatchCheck(ctx.agentDb, { id: created.watchId, lastResult: { pending: 4 } });
      const row = await getWatch(ctx.agentDb, { id: created.watchId });
      expect(row?.lastCheckedAt).toBeInstanceOf(Date);
      expect(row?.lastResult).toMatchObject({ pending: 4 });
      expect(row?.tickCount).toBe(1);
    }
  );
});

// The delivery claim's fencing token: a hung deliverer is taken over, so an unfenced release or mark would touch the new owner's claim.
describe("the delivery claim", () => {
  async function firedWatch(seeded: Seeded) {
    const created = await create({ seeded });
    expect(created.ok).toBe(true);
    if (!created.ok) throw new Error("the watch wasn't created");
    const transitioned = await transitionWatchCondition(ctx.agentDb, {
      id: created.watchId,
      status: "fired",
      lastResult: { result: "satisfied", facts: { verified: true } },
    });
    expect(transitioned).toMatchObject({ deliveryStatus: "pending" });
    return created.watchId;
  }

  function staleBefore() {
    return new Date(Date.now() - WATCH_DELIVERY_CLAIM_STALE_MS);
  }

  async function ageClaim(watchId: string) {
    await ctx.prisma.$executeRawUnsafe(
      `update trigger_dashboard_agent.watches
       set delivery_claimed_at = now() - interval '1 hour' where id = $1`,
      watchId
    );
  }

  postgresTest(
    "a stale takeover makes the old owner's release a no-op, and the new owner delivers once",
    async ({ prisma, postgresContainer }) => {
      await boot(prisma, postgresContainer.getConnectionUri());
      const seeded = await seed(prisma, "claim-fence");
      await seedChat(seeded);
      const watchId = await firedWatch(seeded);

      const a = await claimWatchDelivery(ctx.agentDb, { id: watchId, staleBefore: staleBefore() });
      expect(a).not.toBeNull();
      if (!a) return;

      await ageClaim(watchId);
      const b = await claimWatchDelivery(ctx.agentDb, { id: watchId, staleBefore: staleBefore() });
      expect(b).not.toBeNull();
      if (!b) return;
      expect(b.claimId).not.toBe(a.claimId);

      expect(
        await releaseWatchDelivery(ctx.agentDb, { id: watchId, claimId: a.claimId })
      ).toBeNull();
      expect(await getWatch(ctx.agentDb, { id: watchId })).toMatchObject({
        deliveryStatus: "delivering",
        deliveryClaimId: b.claimId,
      });

      expect(
        await claimWatchDelivery(ctx.agentDb, { id: watchId, staleBefore: staleBefore() })
      ).toBeNull();

      expect(
        await markWatchDelivered(ctx.agentDb, { id: watchId, claimId: b.claimId })
      ).toMatchObject({ deliveryStatus: "delivered" });
      expect(await markWatchDelivered(ctx.agentDb, { id: watchId, claimId: b.claimId })).toBeNull();
    }
  );

  postgresTest(
    "a late delivered-mark from the old owner completes nothing",
    async ({ prisma, postgresContainer }) => {
      await boot(prisma, postgresContainer.getConnectionUri());
      const seeded = await seed(prisma, "claim-late");
      await seedChat(seeded);
      const watchId = await firedWatch(seeded);

      const a = await claimWatchDelivery(ctx.agentDb, { id: watchId, staleBefore: staleBefore() });
      expect(a).not.toBeNull();
      if (!a) return;
      await ageClaim(watchId);
      const b = await claimWatchDelivery(ctx.agentDb, { id: watchId, staleBefore: staleBefore() });
      expect(b).not.toBeNull();
      if (!b) return;

      expect(await markWatchDelivered(ctx.agentDb, { id: watchId, claimId: a.claimId })).toBeNull();
      expect(await markWatchDelivered(ctx.agentDb, { id: watchId })).toBeNull();
      expect(await getWatch(ctx.agentDb, { id: watchId })).toMatchObject({
        deliveryStatus: "delivering",
        deliveredAt: null,
      });

      expect(
        await markWatchDelivered(ctx.agentDb, { id: watchId, claimId: b.claimId })
      ).toMatchObject({ deliveryStatus: "delivered" });
    }
  );

  postgresTest(
    "the inline path marks a pending delivery without a claim",
    async ({ prisma, postgresContainer }) => {
      await boot(prisma, postgresContainer.getConnectionUri());
      const seeded = await seed(prisma, "claim-inline");
      await seedChat(seeded);
      const watchId = await firedWatch(seeded);

      expect(await markWatchDelivered(ctx.agentDb, { id: watchId })).toMatchObject({
        deliveryStatus: "delivered",
      });
      expect(await markWatchDelivered(ctx.agentDb, { id: watchId })).toBeNull();
      expect(
        await claimWatchDelivery(ctx.agentDb, { id: watchId, staleBefore: staleBefore() })
      ).toBeNull();
    }
  );
});

describe("deleting a chat while a watch is being created", () => {
  postgresTest("holds in both orders", async ({ prisma, postgresContainer }) => {
    await boot(prisma, postgresContainer.getConnectionUri());
    const seeded = await seed(prisma, "race");

    for (const deleteFirst of [true, false]) {
      const chatId = `chat_${deleteFirst ? "del" : "add"}`;
      await seedChat(seeded, chatId);

      const creating = () => create({ seeded, chatId });
      const deleting = () =>
        deleteChatWithWatches({
          chatId,
          userId: seeded.user.id,
          organizationId: seeded.organization.id,
        });
      const [a, b] = deleteFirst
        ? await Promise.all([deleting(), creating()])
        : await Promise.all([creating(), deleting()]);
      expect(a).toBeDefined();
      expect(b).toBeDefined();

      expect(await listActiveWatchesForChat(ctx.agentDb, { chatId })).toEqual([]);
      expect(
        await chatExists(ctx.agentDb, {
          chatId,
          userId: seeded.user.id,
          organizationId: seeded.organization.id,
        })
      ).toBe(false);
    }
  });

  postgresTest(
    "refuses a create against an already-deleted chat",
    async ({ prisma, postgresContainer }) => {
      await boot(prisma, postgresContainer.getConnectionUri());
      const seeded = await seed(prisma, "race");
      await seedChat(seeded);
      await deleteChatWithWatches({
        chatId: "chat_1",
        userId: seeded.user.id,
        organizationId: seeded.organization.id,
      });

      expect(await create({ seeded })).toMatchObject({ ok: false, code: "chat_not_found" });
      expect(await listActiveWatchesForChat(ctx.agentDb, { chatId: "chat_1" })).toEqual([]);
    }
  );
});

describe("appendChatMessageOnce", () => {
  postgresTest(
    "appends in order without rewriting the transcript",
    async ({ prisma, postgresContainer }) => {
      await boot(prisma, postgresContainer.getConnectionUri());
      const seeded = await seed(prisma, "append");
      await seedChat(seeded);

      const first = { id: "watch-card:watch_1", role: "assistant", parts: [] };
      const second = { id: "watch-card:watch_2", role: "assistant", parts: [] };

      expect(
        await appendChatMessageOnce(ctx.agentDb, {
          chatId: "chat_1",
          userId: seeded.user.id,
          organizationId: seeded.organization.id,
          message: first,
        })
      ).toBe(true);
      await appendChatMessageOnce(ctx.agentDb, {
        chatId: "chat_1",
        userId: seeded.user.id,
        organizationId: seeded.organization.id,
        message: second,
      });

      const messages = await getChatMessages(ctx.agentDb, {
        chatId: "chat_1",
        userId: seeded.user.id,
        organizationId: seeded.organization.id,
      });
      expect(messages).toEqual([first, second]);
    }
  );

  postgresTest(
    "appends nothing for a chat the caller doesn't own",
    async ({ prisma, postgresContainer }) => {
      await boot(prisma, postgresContainer.getConnectionUri());
      const seeded = await seed(prisma, "append-owner");
      await seedChat(seeded);

      expect(
        await appendChatMessageOnce(ctx.agentDb, {
          chatId: "chat_1",
          userId: "user_someone_else",
          organizationId: seeded.organization.id,
          message: { id: "watch-card:watch_1", role: "assistant", parts: [] },
        })
      ).toBe(false);

      const messages = await getChatMessages(ctx.agentDb, {
        chatId: "chat_1",
        userId: seeded.user.id,
        organizationId: seeded.organization.id,
      });
      expect(messages).toEqual([]);
    }
  );
});

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
