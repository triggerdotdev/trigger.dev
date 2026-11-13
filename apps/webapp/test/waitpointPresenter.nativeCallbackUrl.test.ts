import { containerTestWithIsolatedRedis } from "@internal/testcontainers";
import { trace } from "@internal/tracing";
import {
  RunEngine,
  StoreWaitpointCoordinator,
  WaitpointStoreCoordinator,
} from "@internal/run-engine";
import { WaitpointId } from "@trigger.dev/core/v3/isomorphic";
import { describe, expect, vi } from "vitest";
import { WaitpointPresenter } from "~/presenters/v3/WaitpointPresenter.server";
import { resolveScopedWaitpointCallback } from "~/services/scopedWaitpointCallback.server";
import { generateScopedHttpCallbackHash } from "~/services/httpCallbackHash.server";
import { ControlPlaneCache } from "~/v3/runOpsMigration/controlPlaneCache.server";
import { ControlPlaneResolver } from "~/v3/runOpsMigration/controlPlaneResolver.server";
import { createWaitpointStoreEnabledResolver } from "~/v3/utils/waitpointStoreEnabled.server";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

describe("waitpoint presenter native callback URL", () => {
  // Catches: the dashboard signs a branch env's native DATETIME callback with the branch's own apiKey while the scoped verifier uses the parent's, so the URL it shows returns 401.
  containerTestWithIsolatedRedis(
    "a branch environment's dashboard DATETIME callback URL passes the scoped callback verifier",
    async ({ prisma, redisOptions }) => {
      const organization = await prisma.organization.create({
        data: {
          title: "Native callbacks",
          slug: "native-callbacks",
          featureFlags: { waitpointStoreEnabled: true },
        },
      });
      const project = await prisma.project.create({
        data: {
          name: "P",
          slug: "p",
          externalRef: "proj_native_callbacks",
          organizationId: organization.id,
        },
      });
      const parent = await prisma.runtimeEnvironment.create({
        data: {
          type: "PREVIEW",
          slug: "preview",
          projectId: project.id,
          organizationId: organization.id,
          apiKey: "tr_preview_parent",
          pkApiKey: "pk_preview_parent",
          shortcode: "preview",
        },
      });
      const branch = await prisma.runtimeEnvironment.create({
        data: {
          type: "PREVIEW",
          slug: "preview-feature",
          branchName: "feature",
          parentEnvironmentId: parent.id,
          projectId: project.id,
          organizationId: organization.id,
          apiKey: "tr_preview_branch",
          pkApiKey: "pk_preview_branch",
          shortcode: "preview-feature",
        },
      });

      const store = new WaitpointStoreCoordinator({ redisOptions });
      const adapter = new StoreWaitpointCoordinator({ store });
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
        tracer: trace.getTracer("waitpoint-presenter-native-callback-url-test"),
        waitpointStore: store,
        waitpointRouting: { store: adapter },
        waitpointStoreEnabled: createWaitpointStoreEnabledResolver(() => undefined, prisma),
      });
      try {
        const { waitpoint } = await adapter.createDateTimeWaitpoint({
          projectId: project.id,
          environmentId: branch.id,
          completedAfter: new Date(Date.now() + 600_000),
        });
        const scope = {
          environmentId: branch.id,
          projectId: project.id,
          organizationId: organization.id,
        };

        // Split off reads the primary directly; split on reads the replica through the cache.
        for (const splitEnabled of [false, true]) {
          const resolver = new ControlPlaneResolver({
            controlPlanePrimary: prisma,
            controlPlaneReplica: prisma,
            cache: new ControlPlaneCache(),
            splitEnabled: () => splitEnabled,
          });
          const detail = await new WaitpointPresenter(
            prisma,
            prisma,
            undefined,
            undefined,
            engine,
            resolver
          ).call({ friendlyId: waitpoint.friendlyId, ...scope });
          expect(detail).not.toBeNull();
          const [, waitpointFriendlyId, hash] =
            new URL(detail!.url).pathname.match(
              /^\/api\/v1\/waitpoints\/tokens\/([^/]+)\/callback\/([^/]+)$/
            ) ?? [];
          expect(waitpointFriendlyId).toBe(waitpoint.friendlyId);
          expect(hash).toMatch(/^wp1\./);

          // Catches: previously issued branch-key scoped callbacks failing after auth normalization.
          const callbackScope = { waitpointId: waitpoint.id, environmentId: branch.id };
          for (const [callbackHash, valid] of [
            [hash!, true],
            [generateScopedHttpCallbackHash(callbackScope, branch.apiKey), true],
            [generateScopedHttpCallbackHash(callbackScope, "unrelated-key"), false],
          ] as const) {
            const resolved = await resolveScopedWaitpointCallback(
              WaitpointId.toId(waitpointFriendlyId!),
              callbackHash,
              {
                resolveEnvironment: (id) => resolver.resolveAuthenticatedEnv(id),
                isWaitpointStoreEnabled: (org) =>
                  engine.waitpointSystem.isWaitpointStoreEnabled(org),
                getWaitpoint: (scope) => engine.getStoreDateTimeWaitpoint(scope),
              }
            );
            if (valid) {
              expect("error" in resolved ? resolved : resolved.waitpoint).toMatchObject({
                id: waitpoint.id,
                status: "PENDING",
              });
            } else {
              expect(resolved).toMatchObject({ status: 401 });
            }
          }
        }

        await engine.completeWaitpoint({
          id: waitpoint.id,
          organizationId: organization.id,
          onlyIfPending: true,
        });
        expect(
          await engine.getStoreDateTimeWaitpoint({ waitpointId: waitpoint.id, ...scope })
        ).toMatchObject({ status: "COMPLETED" });
      } finally {
        await engine.quit();
        await store.quit();
      }
    }
  );
});
