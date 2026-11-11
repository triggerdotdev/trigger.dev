import { containerTestWithIsolatedRedis as containerTest } from "@internal/testcontainers";
import { trace } from "@internal/tracing";
import { describe, expect, vi } from "vitest";
import { RunEngine } from "../index.js";
import { WaitpointStoreCoordinator } from "../waitpointCoordinator/storeCoordinator.js";
import { StoreWaitpointCoordinator } from "../waitpointCoordinator/storeWaitpointCoordinator.js";
import { setupAuthenticatedEnvironment } from "./setup.js";
import { generateScopedHttpCallbackHash } from "../../../../../apps/webapp/app/services/httpCallbackHash.server.js";
import { resolveScopedWaitpointCallback } from "../../../../../apps/webapp/app/services/scopedWaitpointCallback.server.js";

describe("storeDateTimeTokenCompatibility", () => {
  vi.setConfig({ testTimeout: 60_000 });

  containerTest(
    "existing DATETIME token callbacks authenticate before store access and retain tenant/disabled fences",
    async ({ prisma, redisOptions }) => {
      const store = new WaitpointStoreCoordinator({ redisOptions });
      const adapter = new StoreWaitpointCoordinator({ store });
      let enabled = true;
      const enabledOrganizations = new Set<string>();
      const engine = new RunEngine({
        prisma,
        worker: { redis: redisOptions, workers: 1, tasksPerWorker: 10, pollIntervalMs: 100 },
        queue: { redis: redisOptions, masterQueueConsumersDisabled: true },
        runLock: { redis: redisOptions },
        machines: {
          defaultMachine: "small-1x",
          machines: { "small-1x": { name: "small-1x", cpu: 0.5, memory: 0.5, centsPerMs: 0.0001 } },
          baseCostInCents: 0.0001,
        },
        tracer: trace.getTracer("token-compatibility-test"),
        waitpointStore: store,
        waitpointRouting: { store: adapter },
        waitpointStoreEnabled: (organizationId) =>
          enabled && enabledOrganizations.has(organizationId),
      });
      try {
        const env = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
        enabledOrganizations.add(env.organization.id);
        const record = await adapter.createDateTimeWaitpoint({
          environmentId: env.id,
          projectId: env.project.id,
          completedAfter: new Date(Date.now() + 60_000),
        });
        const waitpointId = record.waitpoint.id;
        const hash = generateScopedHttpCallbackHash(
          { waitpointId, environmentId: env.id },
          env.apiKey
        );
        const deps = {
          isWaitpointStoreEnabled: engine.waitpointSystem.isWaitpointStoreEnabled.bind(
            engine.waitpointSystem
          ),
          resolveEnvironment: (id: string) =>
            prisma.runtimeEnvironment.findFirst({
              where: { id },
              include: { project: true, organization: true, parentEnvironment: true },
            }),
          getWaitpoint: engine.getStoreDateTimeWaitpoint.bind(engine),
        };
        const valid = await resolveScopedWaitpointCallback(waitpointId, hash, deps);
        expect(valid).not.toHaveProperty("error");
        expect("waitpoint" in valid && valid.waitpoint).toMatchObject({
          id: waitpointId,
          type: "DATETIME",
          status: "PENDING",
        });

        const foreign = await prisma.runtimeEnvironment.create({
          data: {
            type: "DEVELOPMENT",
            slug: "foreign-token",
            projectId: env.project.id,
            organizationId: env.organization.id,
            apiKey: "foreign-token",
            pkApiKey: "foreign-token",
            shortcode: "foreign-token",
          },
        });
        const foreignHash = generateScopedHttpCallbackHash(
          { waitpointId, environmentId: foreign.id },
          foreign.apiKey
        );
        expect(await resolveScopedWaitpointCallback(waitpointId, foreignHash, deps)).toMatchObject({
          status: 404,
        });
        expect(
          await engine.getStoreDateTimeWaitpoint({
            waitpointId,
            environmentId: env.id,
            projectId: "foreign-project",
            organizationId: env.organization.id,
          })
        ).toBeNull();
        expect(
          await engine.getStoreDateTimeWaitpoint({
            waitpointId,
            environmentId: env.id,
            projectId: env.project.id,
          })
        ).toBeNull();

        const isolatedOrg = await prisma.organization.create({
          data: { title: "Isolated token org", slug: "isolated-token-org" },
        });
        const isolatedProject = await prisma.project.create({
          data: {
            name: "Isolated token project",
            slug: "isolated-token-project",
            externalRef: "isolated-token-project",
            organizationId: isolatedOrg.id,
          },
        });
        const isolatedEnv = await prisma.runtimeEnvironment.create({
          data: {
            type: "PRODUCTION",
            slug: "isolated",
            projectId: isolatedProject.id,
            organizationId: isolatedOrg.id,
            apiKey: "isolated-token-key",
            pkApiKey: "isolated-token-key",
            shortcode: "isolated-token",
          },
        });
        const isolatedHash = generateScopedHttpCallbackHash(
          { waitpointId, environmentId: isolatedEnv.id },
          isolatedEnv.apiKey
        );
        const branch = await prisma.runtimeEnvironment.create({
          data: {
            type: "PREVIEW",
            slug: "branch-token",
            projectId: env.project.id,
            organizationId: env.organization.id,
            apiKey: "branch-token-key",
            pkApiKey: "branch-token-key",
            shortcode: "branch-token",
            parentEnvironmentId: env.id,
          },
        });
        const branchRecord = await adapter.createDateTimeWaitpoint({
          environmentId: branch.id,
          projectId: env.project.id,
          completedAfter: new Date(Date.now() + 60_000),
        });
        const branchHash = generateScopedHttpCallbackHash(
          { waitpointId: branchRecord.waitpoint.id, environmentId: branch.id },
          env.apiKey
        );
        const branchResult = await resolveScopedWaitpointCallback(
          branchRecord.waitpoint.id,
          branchHash,
          deps
        );
        expect("waitpoint" in branchResult && branchResult.waitpoint.id).toBe(
          branchRecord.waitpoint.id
        );

        // Concurrent token completions retain Postgres first-winner semantics.
        const contenders = ["false", '{"second":true}'];
        const results = await Promise.all(
          contenders.map((value) =>
            engine.completeWaitpoint({
              id: waitpointId,
              organizationId: env.organization.id,
              onlyIfPending: true,
              output: { value, type: "application/json", isError: false },
            })
          )
        );
        expect(results.every((result) => result.status === "COMPLETED")).toBe(true);
        const complete = await resolveScopedWaitpointCallback(waitpointId, hash, deps);
        expect("waitpoint" in complete && complete.waitpoint).toMatchObject({
          id: waitpointId,
          status: "COMPLETED",
          output: expect.stringMatching(/^(false|\{"second":true\})$/),
          outputType: "application/json",
          outputIsError: false,
        });
        const winner = "waitpoint" in complete ? complete.waitpoint.output : undefined;
        expect(contenders).toContain(winner);
        await engine["worker"].enqueue({
          id: "token-completed-deadline",
          job: "finishWaitpoint",
          payload: { waitpointId, organizationId: env.organization.id },
        });
        await vi.waitFor(
          async () => {
            expect(
              await engine["worker"].queue.getJob("token-completed-deadline"),
              "recovery job never left the worker queue"
            ).toBeNull();
          },
          { timeout: 5_000 }
        );
        expect(
          await engine.getStoreDateTimeWaitpoint({
            waitpointId,
            environmentId: env.id,
            projectId: env.project.id,
            organizationId: env.organization.id,
          })
        ).toMatchObject({ status: "COMPLETED", output: winner });
        expect(await prisma.waitpoint.count({ where: { id: waitpointId } })).toBe(0);

        await store.quit();
        // These must return their normal rejection while the real store is unavailable.
        const badSignature = `${hash.slice(0, -1)}${hash.endsWith("0") ? "1" : "0"}`;
        expect(await resolveScopedWaitpointCallback(waitpointId, badSignature, deps)).toMatchObject(
          {
            status: 401,
          }
        );
        expect(await resolveScopedWaitpointCallback("another-waitpoint", hash, deps)).toMatchObject(
          {
            status: 401,
          }
        );

        expect(await resolveScopedWaitpointCallback(waitpointId, isolatedHash, deps)).toMatchObject(
          {
            status: 404,
          }
        );

        enabled = false;
        expect(await resolveScopedWaitpointCallback(waitpointId, hash, deps)).toMatchObject({
          status: 404,
        });
        const manual = await engine.createManualWaitpoint({
          environmentId: env.id,
          projectId: env.project.id,
          organizationId: env.organization.id,
        });
        expect(
          await engine.getWaitpoint({
            waitpointId: manual.waitpoint.id,
            environmentId: env.id,
            projectId: env.project.id,
          })
        ).toMatchObject({ id: manual.waitpoint.id, type: "MANUAL" });
      } finally {
        await engine.quit();
        await store.quit();
      }
    }
  );
});
