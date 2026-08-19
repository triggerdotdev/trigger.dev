import {
  createChat,
  createDashboardAgentDb,
  createWatch,
  listActiveWatchesForBatch,
  recordWatchCheck,
  type DashboardAgentDb,
  type DashboardAgentDbClient,
} from "@internal/dashboard-agent-db";
import { applyDashboardAgentMigrations } from "@internal/dashboard-agent-db/testing";
import { postgresTest } from "@internal/testcontainers";
import { afterEach, describe, expect } from "vitest";

// A group larger than the batch cap must rotate: the same prefix winning every tick would
// starve the rest for as long as the group stays full.

let agentDbClient: DashboardAgentDbClient | undefined;
let agentDb: DashboardAgentDb;

const ENVIRONMENT_ID = "env_batch_fairness";
const CADENCE = 5;

/** `count` active watches in one (environment, cadence) group, spread over enough chats. */
async function seedGroup(count: number, expiresAt: Date, prefix = "a"): Promise<string[]> {
  const ids: string[] = [];
  for (let index = 0; index < count; index++) {
    const chatId = `chat_${prefix}_${Math.floor(index / 3)}`;
    if (index % 3 === 0) {
      await createChat(agentDb, { id: chatId, organizationId: "org_1", userId: "user_1" });
    }
    const created = await createWatch(agentDb, {
      chatId,
      identity: `run_finished:run_${prefix}_${index}`,
      spec: {
        kind: "run_finished",
        runId: `run_${prefix}_${index}`,
        checkEveryMinutes: CADENCE,
        maxHours: 6,
        note: "",
      },
      organizationId: "org_1",
      projectId: "proj_1",
      environmentId: ENVIRONMENT_ID,
      userId: "user_1",
      // Staggered, so soonest-deadline-first would deterministically pick the same prefix.
      expiresAt: new Date(expiresAt.getTime() + index * 60_000),
    });
    expect(created.ok).toBe(true);
    if (created.ok) ids.push(created.watch.id);
  }
  return ids;
}

/** One tick: take a capped page and mark every watch on it as checked. */
async function tick(limit: number): Promise<string[]> {
  const page = await listActiveWatchesForBatch(agentDb, {
    environmentId: ENVIRONMENT_ID,
    cadenceMinutes: CADENCE,
    limit,
  });
  for (const watch of page) {
    await recordWatchCheck(agentDb, { id: watch.id });
  }
  return page.map((watch) => watch.id);
}

afterEach(async () => {
  await agentDbClient?.close();
  agentDbClient = undefined;
});

describe("the batch group's fairness", () => {
  postgresTest(
    "checks every watch of an over-cap group within a bounded number of ticks",
    async ({ prisma, postgresContainer }) => {
      await applyDashboardAgentMigrations((statement) => prisma.$executeRawUnsafe(statement));
      agentDbClient = createDashboardAgentDb(postgresContainer.getConnectionUri(), { max: 4 });
      agentDb = agentDbClient.db;

      const inSixHours = new Date(Date.now() + 6 * 60 * 60 * 1000);
      const all = await seedGroup(12, inSixHours);

      const cap = 5;
      const checked = new Set<string>();
      // ceil(12 / 5) = 3 ticks is the whole group, and the fourth must start over.
      for (let round = 0; round < 3; round++) {
        for (const id of await tick(cap)) checked.add(id);
      }

      expect(checked.size).toBe(all.length);
      expect([...checked].sort()).toEqual([...all].sort());
    }
  );

  postgresTest(
    "a watch whose window closes within a cadence is never deferred by the cap",
    async ({ prisma, postgresContainer }) => {
      await applyDashboardAgentMigrations((statement) => prisma.$executeRawUnsafe(statement));
      agentDbClient = createDashboardAgentDb(postgresContainer.getConnectionUri(), { max: 4 });
      agentDb = agentDbClient.db;

      const inSixHours = new Date(Date.now() + 6 * 60 * 60 * 1000);
      await seedGroup(6, inSixHours);
      // Checked a moment ago, so pure least-recently-checked order would put it last.
      const [closing] = await seedGroup(1, new Date(Date.now() + 60_000), "b");
      await recordWatchCheck(agentDb, { id: closing!, lastCheckedAt: new Date() });

      const page = await tick(2);
      expect(page[0]).toBe(closing);
    }
  );
});
