import { containerTest } from "@internal/testcontainers";
import { trace } from "@internal/tracing";
import { expect } from "vitest";
import { RunEngine } from "../index.js";
import type { CrossSeamGuardHook } from "../types.js";
import { setupAuthenticatedEnvironment } from "./setup.js";

vi.setConfig({ testTimeout: 60_000 });

function engineOptions(redisOptions: any, prisma: any, crossSeamGuard?: CrossSeamGuardHook) {
  return {
    prisma,
    worker: {
      redis: redisOptions,
      workers: 1,
      tasksPerWorker: 10,
      pollIntervalMs: 100,
    },
    queue: {
      redis: redisOptions,
    },
    runLock: {
      redis: redisOptions,
    },
    machines: {
      defaultMachine: "small-1x" as const,
      machines: {
        "small-1x": {
          name: "small-1x" as const,
          cpu: 0.5,
          memory: 0.5,
          centsPerMs: 0.0001,
        },
      },
      baseCostInCents: 0.0001,
    },
    tracer: trace.getTracer("test", "0.0.0"),
    ...(crossSeamGuard ? { crossSeamGuard } : {}),
  };
}

describe("RunEngine completeWaitpoint cross-seam guard", () => {
  containerTest(
    "consults the crossSeamGuard first (RESUME_TOKEN), then delegates",
    async ({ prisma, redisOptions }) => {
      const authenticatedEnvironment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");

      const seen: Array<{ waitpointId: string; routeKind: string }> = [];
      const engine = new RunEngine(
        engineOptions(redisOptions, prisma, async ({ waitpointId, routeKind }) => {
          seen.push({ waitpointId, routeKind });
          // Single-store / split-OFF returns the single ("legacy") store; the engine
          // delegates regardless of decision.store (routing lives below, in waitpointSystem).
          return { store: "legacy", residency: "LEGACY", routeKind };
        })
      );

      try {
        const { waitpoint } = await engine.createManualWaitpoint({
          environmentId: authenticatedEnvironment.id,
          projectId: authenticatedEnvironment.projectId,
        });
        expect(waitpoint.status).toBe("PENDING");

        await engine.completeWaitpoint({
          id: waitpoint.id,
          output: { value: "{}", isError: false },
        });

        // (A) the guard was consulted first, with the right id + RESUME_TOKEN route kind.
        expect(seen).toEqual([{ waitpointId: waitpoint.id, routeKind: "RESUME_TOKEN" }]);

        // (B) the completion was then applied via delegation (single-store path).
        const after = await prisma.waitpoint.findFirst({ where: { id: waitpoint.id } });
        expect(after?.status).toBe("COMPLETED");
      } finally {
        await engine.quit();
      }
    }
  );

  containerTest(
    "propagates a guard throw and does NOT apply the completion (loud)",
    async ({ prisma, redisOptions }) => {
      const authenticatedEnvironment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");

      const engine = new RunEngine(
        engineOptions(redisOptions, prisma, async () => {
          throw new Error("UnclassifiableRunId");
        })
      );

      try {
        const { waitpoint } = await engine.createManualWaitpoint({
          environmentId: authenticatedEnvironment.id,
          projectId: authenticatedEnvironment.projectId,
        });
        expect(waitpoint.status).toBe("PENDING");

        await expect(
          engine.completeWaitpoint({ id: waitpoint.id, output: { value: "{}", isError: false } })
        ).rejects.toThrow();

        // (C) the throw short-circuited before delegation — no silent local apply.
        const after = await prisma.waitpoint.findFirst({ where: { id: waitpoint.id } });
        expect(after?.status).toBe("PENDING");
      } finally {
        await engine.quit();
      }
    }
  );

  containerTest(
    "with no crossSeamGuard behaves exactly as today",
    async ({ prisma, redisOptions }) => {
      const authenticatedEnvironment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");

      const engine = new RunEngine(engineOptions(redisOptions, prisma));

      try {
        const { waitpoint } = await engine.createManualWaitpoint({
          environmentId: authenticatedEnvironment.id,
          projectId: authenticatedEnvironment.projectId,
        });
        expect(waitpoint.status).toBe("PENDING");

        await engine.completeWaitpoint({
          id: waitpoint.id,
          output: { value: "{}", isError: false },
        });

        // (D) unwired path applies exactly as today.
        const after = await prisma.waitpoint.findFirst({ where: { id: waitpoint.id } });
        expect(after?.status).toBe("COMPLETED");
      } finally {
        await engine.quit();
      }
    }
  );
});
