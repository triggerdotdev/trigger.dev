import { describe, expect, onTestFinished, vi } from "vitest";

vi.mock("~/db.server", () => ({
  prisma: {},
  $replica: {},
  runOpsNewPrisma: {},
  runOpsLegacyPrisma: {},
}));

vi.mock("~/v3/runOpsMigration/splitMode.server", () => ({ isSplitEnabled: async () => false }));

vi.mock("~/services/platform.v3.server", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    getEntitlement: vi.fn(),
  };
});

import { setupAuthenticatedEnvironment, setupBackgroundWorker } from "@internal/run-engine/tests";
import { assertNonNullable, containerTest } from "@internal/testcontainers";
import {
  createEngine,
  createService,
  RecordingExternalDeploymentCache,
} from "./triggerTask.externalDeploymentId.helpers";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

describe("triggerTask session input seq", () => {
  // Catches: the `.in` seqs a session run was triggered with being dropped on the way to the run row,
  // so the run-end check has nothing exact to compare against and falls back to timestamps.
  containerTest(
    "stores the session input seqs in the run's annotations, in the insert that creates it",
    async ({ prisma, redisOptions }) => {
      const engine = createEngine(prisma, redisOptions);
      onTestFinished(() => engine.quit());

      const environment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
      const taskIdentifier = "session-task";
      await setupBackgroundWorker(engine, environment, taskIdentifier);

      const service = createService(prisma, engine, new RecordingExternalDeploymentCache());

      const anchored = await service.call({
        taskId: taskIdentifier,
        environment,
        body: { payload: { test: "x" } },
        options: { sessionInSeq: 7, sessionInFirstSeq: 5 },
      });
      const plain = await service.call({
        taskId: taskIdentifier,
        environment,
        body: { payload: { test: "x" } },
      });
      assertNonNullable(anchored);
      assertNonNullable(plain);

      const anchoredRun = await prisma.taskRun.findFirstOrThrow({ where: { id: anchored.run.id } });
      const plainRun = await prisma.taskRun.findFirstOrThrow({ where: { id: plain.run.id } });

      const anchoredAnnotations = anchoredRun.annotations as Record<string, unknown>;
      const plainAnnotations = plainRun.annotations as Record<string, unknown>;
      expect(anchoredAnnotations.sessionInSeq).toBe(7);
      expect(anchoredAnnotations.sessionInFirstSeq).toBe(5);
      expect(plainAnnotations.sessionInSeq).toBeUndefined();
      expect(plainAnnotations.sessionInFirstSeq).toBeUndefined();
    }
  );
});
