import { containerTest } from "@internal/testcontainers";
import { trace } from "@internal/tracing";
import { parseWaitpointId } from "@trigger.dev/core/v3/isomorphic";
import type { PrismaClient } from "@trigger.dev/database";
import type { RedisOptions } from "@internal/redis";
import { describe, expect } from "vitest";
import { RunEngine } from "../index.js";
import type { WaitpointArm } from "./helpers/engineFactory.js";
import { setupAuthenticatedEnvironment } from "./setup.js";

vi.setConfig({ testTimeout: 60_000 });

function engineFor(arm: WaitpointArm, prisma: PrismaClient, redisOptions: RedisOptions) {
  return new RunEngine({
    prisma,
    worker: { redis: redisOptions, workers: 1, tasksPerWorker: 10, pollIntervalMs: 100 },
    queue: { redis: redisOptions },
    runLock: { redis: redisOptions },
    // The arm under test is selected by whether a store is configured AT ALL, plus the mint
    // kind each call passes. Both together are what a flipped organization looks like.
    waitpointStore: arm === "store" ? { redis: redisOptions } : undefined,
    machines: {
      defaultMachine: "small-1x",
      machines: {
        "small-1x": { name: "small-1x" as const, cpu: 0.5, memory: 0.5, centsPerMs: 0.0001 },
      },
      baseCostInCents: 0.0001,
    },
    tracer: trace.getTracer("test", "0.0.0"),
  });
}

const expectedFormat: Record<WaitpointArm, string> = { legacy: "legacy", store: "b32hexW" };

describe.each<WaitpointArm>(["legacy", "store"])("standalone waitpoint creates (%s arm)", (arm) => {
  containerTest(
    "createManualWaitpoint mints into the expected system",
    async ({ prisma, redisOptions }) => {
      const environment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
      const engine = engineFor(arm, prisma, redisOptions);

      try {
        const { waitpoint } = await engine.createManualWaitpoint({
          environmentId: environment.id,
          projectId: environment.project.id,
          waitpointMintKind: arm,
        });

        expect(parseWaitpointId(waitpoint.id).format).toBe(expectedFormat[arm]);
        expect(waitpoint.status).toBe("PENDING");
        expect(waitpoint.type).toBe("MANUAL");
        // Read unconditionally by the debounce path, so it must never be undefined.
        expect(waitpoint.outputIsError).toBe(false);
      } finally {
        await engine.quit();
      }
    }
  );

  containerTest(
    "a repeated idempotency key returns the cached waitpoint",
    async ({ prisma, redisOptions }) => {
      const environment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
      const engine = engineFor(arm, prisma, redisOptions);

      try {
        const args = {
          environmentId: environment.id,
          projectId: environment.project.id,
          idempotencyKey: "same-key",
          waitpointMintKind: arm,
        } as const;

        const first = await engine.createManualWaitpoint(args);
        const second = await engine.createManualWaitpoint(args);

        expect(first.isCached).toBe(false);
        expect(second.isCached).toBe(true);
        expect(second.waitpoint.id).toBe(first.waitpoint.id);
      } finally {
        await engine.quit();
      }
    }
  );

  containerTest(
    "createDateTimeWaitpoint mints into the expected system",
    async ({ prisma, redisOptions }) => {
      const environment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
      const engine = engineFor(arm, prisma, redisOptions);

      try {
        const { waitpoint } = await engine.createDateTimeWaitpoint({
          environmentId: environment.id,
          projectId: environment.project.id,
          completedAfter: new Date(Date.now() + 60_000),
          waitpointMintKind: arm,
        });

        expect(parseWaitpointId(waitpoint.id).format).toBe(expectedFormat[arm]);
        expect(waitpoint.type).toBe("DATETIME");
        expect(waitpoint.completedAfter).not.toBeNull();
      } finally {
        await engine.quit();
      }
    }
  );
});

describe("standalone waitpoint creates, mint-kind fallback", () => {
  // Reversibility: clearing the flag must revert the NEXT mint with no deploy, and an
  // engine that has a store configured must still mint legacy when told to.
  containerTest(
    "a legacy mint stays legacy even with a store configured",
    async ({ prisma, redisOptions }) => {
      const environment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
      const engine = engineFor("store", prisma, redisOptions);

      try {
        const { waitpoint } = await engine.createManualWaitpoint({
          environmentId: environment.id,
          projectId: environment.project.id,
          waitpointMintKind: "legacy",
        });

        expect(parseWaitpointId(waitpoint.id).format).toBe("legacy");
      } finally {
        await engine.quit();
      }
    }
  );

  // Fail safe, not fail loud: a store mint on a process with no store configured must not
  // turn every trigger for a flipped organization into an error.
  containerTest(
    "a store mint falls back to legacy when no store is configured",
    async ({ prisma, redisOptions }) => {
      const environment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
      const engine = engineFor("legacy", prisma, redisOptions);

      try {
        const { waitpoint } = await engine.createManualWaitpoint({
          environmentId: environment.id,
          projectId: environment.project.id,
          waitpointMintKind: "store",
        });

        expect(parseWaitpointId(waitpoint.id).format).toBe("legacy");
      } finally {
        await engine.quit();
      }
    }
  );
});
