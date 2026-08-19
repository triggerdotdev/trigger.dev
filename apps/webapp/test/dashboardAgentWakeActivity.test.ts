import {
  cancelWatch,
  createChat,
  createDashboardAgentDb,
  createWatch,
  readDashboardAgentWakeActivity,
  type DashboardAgentDb,
  type DashboardAgentDbClient,
} from "@internal/dashboard-agent-db";
import { applyDashboardAgentMigrations } from "@internal/dashboard-agent-db/testing";
import { postgresTest } from "@internal/testcontainers";
import { afterEach, describe, expect } from "vitest";

// What the environment layout loader hands the browser. An active watch has to be part of it:
// without it a fresh browser with a watch created elsewhere never starts polling.

let agentDbClient: DashboardAgentDbClient | undefined;
let agentDb: DashboardAgentDb;

const SCOPE = { organizationId: "org_1", userId: "user_1" };

async function seedWatch(): Promise<string> {
  await createChat(agentDb, { id: "chat_1", ...SCOPE });
  const created = await createWatch(agentDb, {
    chatId: "chat_1",
    identity: "run_finished:run_1",
    spec: { kind: "run_finished", runId: "run_1", checkEveryMinutes: 5, maxHours: 6, note: "" },
    projectId: "proj_1",
    environmentId: "env_1",
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    ...SCOPE,
  });
  expect(created.ok).toBe(true);
  return created.ok ? created.watch.id : "";
}

afterEach(async () => {
  await agentDbClient?.close();
  agentDbClient = undefined;
});

describe("the page load's wake activity", () => {
  postgresTest(
    "reports an active watch that has never woken anyone",
    async ({ prisma, postgresContainer }) => {
      await applyDashboardAgentMigrations((statement) => prisma.$executeRawUnsafe(statement));
      agentDbClient = createDashboardAgentDb(postgresContainer.getConnectionUri(), { max: 2 });
      agentDb = agentDbClient.db;

      expect(await readDashboardAgentWakeActivity(agentDb, SCOPE)).toEqual({
        unreadWakes: 0,
        hasActiveWatches: false,
      });

      const watchId = await seedWatch();
      expect(await readDashboardAgentWakeActivity(agentDb, SCOPE)).toEqual({
        unreadWakes: 0,
        hasActiveWatches: true,
      });

      // Another user in the same org sees nothing.
      expect(await readDashboardAgentWakeActivity(agentDb, { ...SCOPE, userId: "user_2" })).toEqual(
        { unreadWakes: 0, hasActiveWatches: false }
      );

      await cancelWatch(agentDb, { id: watchId, reason: "user" });
      expect(await readDashboardAgentWakeActivity(agentDb, SCOPE)).toEqual({
        unreadWakes: 0,
        hasActiveWatches: false,
      });
    }
  );
});
