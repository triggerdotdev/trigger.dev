import {
  claimWatchDelivery,
  createChat,
  createDashboardAgentDb,
  createWatch,
  deleteTerminalWatchesOlderThan,
  getWatch,
  listChats,
  releaseWatchDelivery,
  softDeleteChat,
  softDeleteChatsForOrganization,
  transitionWatchCondition,
  type DashboardAgentDb,
  type DashboardAgentDbClient,
} from "@internal/dashboard-agent-db";
import { applyDashboardAgentMigrations } from "@internal/dashboard-agent-db/testing";
import { postgresTest } from "@internal/testcontainers";
import type { PrismaClient } from "@trigger.dev/database";
import { afterEach, describe, expect } from "vitest";

let agentDbClient: DashboardAgentDbClient | undefined;

async function boot(prisma: PrismaClient, connectionUri: string): Promise<DashboardAgentDb> {
  await applyDashboardAgentMigrations((statement) => prisma.$executeRawUnsafe(statement));
  agentDbClient = createDashboardAgentDb(connectionUri, { max: 2 });
  return agentDbClient.db;
}

afterEach(async () => {
  await agentDbClient?.close();
  agentDbClient = undefined;
});

const ORG = "org_owner";
const OTHER_ORG = "org_other";
const USER = "user_owner";

describe("softDeleteChat tenant isolation", () => {
  postgresTest(
    "a soft-delete scoped to another org leaves the chat intact",
    async ({ prisma, postgresContainer }) => {
      const db = await boot(prisma, postgresContainer.getConnectionUri());

      await createChat(db, { id: "chat_1", organizationId: ORG, userId: USER });

      // Right user, wrong org: must not delete.
      const wrongOrg = await softDeleteChat(db, {
        chatId: "chat_1",
        userId: USER,
        organizationId: OTHER_ORG,
      });
      expect(wrongOrg.deleted).toBe(false);
      expect(await listChats(db, { organizationId: ORG, userId: USER })).toHaveLength(1);

      // Right org and user: deletes.
      const rightOrg = await softDeleteChat(db, {
        chatId: "chat_1",
        userId: USER,
        organizationId: ORG,
      });
      expect(rightOrg.deleted).toBe(true);
      expect(await listChats(db, { organizationId: ORG, userId: USER })).toHaveLength(0);
    },
    30_000
  );

  postgresTest(
    "deleting twice is a no-op: the retention cutoff doesn't move",
    async ({ prisma, postgresContainer }) => {
      const db = await boot(prisma, postgresContainer.getConnectionUri());
      const deletedAt = async () =>
        (
          await prisma.$queryRawUnsafe<{ deleted_at: Date | null }[]>(
            `select deleted_at from trigger_dashboard_agent.chats where id = 'chat_1'`
          )
        )[0]?.deleted_at;

      await createChat(db, { id: "chat_1", organizationId: ORG, userId: USER });
      const params = { chatId: "chat_1", userId: USER, organizationId: ORG };

      expect((await softDeleteChat(db, params)).deleted).toBe(true);
      const first = await deletedAt();
      expect(first).toBeInstanceOf(Date);

      // A retry finds nothing left to delete, so the stamp stands.
      expect((await softDeleteChat(db, params)).deleted).toBe(false);
      expect(await deletedAt()).toEqual(first);
    },
    30_000
  );
});

/**
 * Both delivery sweeps skip a watch whose chat is deleted, and retention only deletes rows
 * whose delivery is settled — so a wake still owed when the chat goes would keep its snapshot
 * until the chat's hard delete (30 days) instead of the much shorter watch retention cutoff.
 */
describe("deleting a chat settles the wakes it still owes", () => {
  async function firedWatch(db: DashboardAgentDb, chatId: string) {
    const created = await createWatch(db, {
      chatId,
      identity: `run_finished:run_${chatId}`,
      spec: {
        kind: "run_finished",
        runId: `run_${chatId}`,
        checkEveryMinutes: 1,
        maxHours: 2,
      } as never,
      organizationId: ORG,
      projectId: "proj_1",
      environmentId: "env_1",
      userId: USER,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    });
    if (!created.ok) throw new Error(`the watch wasn't created: ${created.error}`);

    const fired = await transitionWatchCondition(db, {
      id: created.watch.id,
      resolution: "condition_met",
      lastResult: { runs: 1 },
    });
    expect(fired?.deliveryStatus).toBe("pending");
    return created.watch.id;
  }

  postgresTest(
    "softDeleteChat settles a fired watch's pending delivery, so retention can reclaim it",
    async ({ prisma, postgresContainer }) => {
      const db = await boot(prisma, postgresContainer.getConnectionUri());
      await createChat(db, { id: "chat_1", organizationId: ORG, userId: USER });
      const watchId = await firedWatch(db, "chat_1");

      await softDeleteChat(db, { chatId: "chat_1", userId: USER, organizationId: ORG });

      expect((await getWatch(db, { id: watchId }))?.deliveryStatus).toBe("not_required");
      expect(
        await deleteTerminalWatchesOlderThan(db, { before: new Date(Date.now() + 60_000) })
      ).toBe(1);
    },
    30_000
  );

  postgresTest(
    "a delivery claimed in flight is settled too, claim and all",
    async ({ prisma, postgresContainer }) => {
      const db = await boot(prisma, postgresContainer.getConnectionUri());
      await createChat(db, { id: "chat_1", organizationId: ORG, userId: USER });
      const watchId = await firedWatch(db, "chat_1");

      // Deleted while a deliverer holds the claim: no sweep can reach the row afterwards, so
      // it would sit in `delivering` for as long as the chat does.
      const claim = await claimWatchDelivery(db, {
        id: watchId,
        staleBefore: new Date(Date.now() - 60_000),
      });
      expect(claim?.watch.deliveryStatus).toBe("delivering");

      await softDeleteChat(db, { chatId: "chat_1", userId: USER, organizationId: ORG });

      const settled = await getWatch(db, { id: watchId });
      expect(settled?.deliveryStatus).toBe("not_required");
      expect(settled?.deliveryClaimId).toBeNull();
      expect(settled?.deliveryClaimedAt).toBeNull();

      // The deliverer that still holds the old claim can no longer move the row either way.
      await releaseWatchDelivery(db, { id: watchId, claimId: claim!.claimId });
      expect((await getWatch(db, { id: watchId }))?.deliveryStatus).toBe("not_required");
    },
    30_000
  );

  postgresTest(
    "softDeleteChatsForOrganization settles them too",
    async ({ prisma, postgresContainer }) => {
      const db = await boot(prisma, postgresContainer.getConnectionUri());
      await createChat(db, { id: "chat_1", organizationId: ORG, userId: USER });
      const watchId = await firedWatch(db, "chat_1");

      expect(await softDeleteChatsForOrganization(db, { organizationId: ORG })).toBe(1);

      expect((await getWatch(db, { id: watchId }))?.deliveryStatus).toBe("not_required");
    },
    30_000
  );
});
