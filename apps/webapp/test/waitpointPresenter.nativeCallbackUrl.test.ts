import { containerTestWithIsolatedRedis } from "@internal/testcontainers";
import { trace } from "@internal/tracing";
import {
  RunEngine,
  StoreWaitpointCoordinator,
  WaitpointStoreCoordinator,
} from "@internal/run-engine";
import { PostgresRunStore } from "@internal/run-store";
import { WaitpointRetrieveTokenResponse } from "@trigger.dev/core/v3";
import { WaitpointId } from "@trigger.dev/core/v3/isomorphic";
import { describe, expect, vi } from "vitest";
import { ApiWaitpointPresenter } from "~/presenters/v3/ApiWaitpointPresenter.server";
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

  // Catches: retrieve returning a MemoryDB token the SDK cannot parse, or retrieve or the dashboard showing it differently from an unflagged organisation's Postgres token.
  containerTestWithIsolatedRedis(
    "MemoryDB token reads match an unflagged organisation in every state",
    async ({ prisma, redisOptions }) => {
      const makeEnvironment = async (name: string) => {
        const organization = await prisma.organization.create({
          data: { title: name, slug: name },
        });
        const project = await prisma.project.create({
          data: {
            name,
            slug: name,
            externalRef: `proj_${name}`,
            organizationId: organization.id,
          },
        });
        const environment = await prisma.runtimeEnvironment.create({
          data: {
            type: "PRODUCTION",
            slug: name,
            projectId: project.id,
            organizationId: organization.id,
            apiKey: `tr_${name}`,
            pkApiKey: `pk_${name}`,
            shortcode: name,
          },
        });
        return { ...environment, project };
      };
      const memoryEnv = await makeEnvironment("flagged");
      const postgresEnv = await makeEnvironment("unflagged");
      const flagged = new Set([memoryEnv.organizationId]);

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
        tracer: trace.getTracer("waitpoint-presenter-memorydb-parity-test"),
        waitpointStore: store,
        waitpointRouting: { store: adapter },
        waitpointStoreEnabled: (organizationId) => flagged.has(organizationId),
      });
      try {
        const runStore = new PostgresRunStore({ prisma, readOnlyPrisma: prisma });
        const isWaitpointStoreEnabled = (organizationId?: string) =>
          engine.waitpointSystem.isWaitpointStoreEnabled(organizationId);
        const retrieve = new ApiWaitpointPresenter(
          prisma,
          prisma,
          undefined,
          runStore,
          (scope) => engine.getStoreDateTimeWaitpoint(scope),
          isWaitpointStoreEnabled
        );
        // The unflagged organisation's reads must never reach MemoryDB.
        const postgresRetrieve = new ApiWaitpointPresenter(
          prisma,
          prisma,
          undefined,
          runStore,
          () => {
            throw new Error("unflagged retrieve read MemoryDB");
          },
          isWaitpointStoreEnabled
        );
        const detail = new WaitpointPresenter(
          prisma,
          prisma,
          undefined,
          runStore,
          engine,
          new ControlPlaneResolver({
            controlPlanePrimary: prisma,
            controlPlaneReplica: prisma,
            cache: new ControlPlaneCache(),
            splitEnabled: () => false,
          })
        );

        type Options = {
          timeout?: Date;
          idempotencyKey?: string;
          idempotencyKeyExpiresAt?: Date;
          tags?: string[];
        };
        const createPair = async (options: Options) => {
          const { waitpoint: memory } = await adapter.createManualWaitpoint({
            projectId: memoryEnv.project.id,
            environmentId: memoryEnv.id,
            mintContext: { organizationId: memoryEnv.organizationId },
            ...options,
          });
          const { waitpoint: postgres } = await engine.createManualWaitpoint({
            projectId: postgresEnv.project.id,
            environmentId: postgresEnv.id,
            organizationId: postgresEnv.organizationId,
            ...options,
          });
          expect(await prisma.waitpoint.count({ where: { id: memory.id } })).toBe(0);
          expect(await prisma.waitpoint.count({ where: { id: postgres.id } })).toBe(1);
          return { memory, postgres };
        };
        const complete = (
          pair: Awaited<ReturnType<typeof createPair>>,
          output: (environmentId: string) => { value: string; type: string; isError: boolean }
        ) =>
          Promise.all([
            engine.completeWaitpoint({
              id: pair.memory.id,
              organizationId: memoryEnv.organizationId,
              output: output(memoryEnv.id),
            }),
            engine.completeWaitpoint({
              id: pair.postgres.id,
              organizationId: postgresEnv.organizationId,
              output: output(postgresEnv.id),
            }),
          ]);
        const jsonOutput = () => ({
          value: '{"ok":true}',
          type: "application/json",
          isError: false,
        });

        const hourAhead = new Date(Date.now() + 3_600_000);
        const secondAhead = new Date(Date.now() + 1_000);
        const states = {
          S1: await createPair({ tags: ["a", "b"] }),
          S2: await createPair({
            idempotencyKey: "customer-key",
            idempotencyKeyExpiresAt: hourAhead,
            timeout: hourAhead,
          }),
          S3: await createPair({}),
          S4: await createPair({}),
          S5: await createPair({ timeout: secondAhead }),
          S6: await createPair({
            idempotencyKey: "expiring-key",
            idempotencyKeyExpiresAt: secondAhead,
          }),
        };
        await complete(states.S3, jsonOutput);
        await complete(states.S4, (environmentId) => ({
          value: `${environmentId}/waitpoints/s4/output.json`,
          type: "application/store",
          isError: false,
        }));
        await complete(states.S6, jsonOutput);
        await expect
          .poll(
            async () =>
              (await prisma.waitpoint.findFirst({ where: { id: states.S5.postgres.id } }))?.status,
            { timeout: 10_000, interval: 100, message: "Postgres token never timed out" }
          )
          .toBe("COMPLETED");
        // The handler of the recoverDateTimeWaitpoint job that a standalone MemoryDB token gets.
        await engine.waitpointSystem.recoverDateTimeWaitpoint({
          manual: true,
          waitpointId: states.S5.memory.id,
          organizationId: memoryEnv.organizationId,
          projectId: memoryEnv.project.id,
          environmentId: memoryEnv.id,
          completedAfter: secondAhead,
        });
        await expect
          .poll(() => Date.now() > secondAhead.getTime(), {
            timeout: 5_000,
            interval: 50,
            message: "S6 idempotency key never expired",
          })
          .toBe(true);

        const withMarker = (value: unknown, environmentId: string) =>
          typeof value === "string" ? value.replaceAll(environmentId, "<env>") : value;
        for (const [state, pair] of Object.entries(states)) {
          const memory = JSON.parse(JSON.stringify(await retrieve.call(memoryEnv, pair.memory.id)));
          const postgres = JSON.parse(
            JSON.stringify(await postgresRetrieve.call(postgresEnv, pair.postgres.id))
          );
          if (state === "S1" || state === "S2") {
            expect(memory.outputType, state).toBe("application/json");
            expect(postgres.outputType, state).toBe("application/json");
          }
          expect(() => WaitpointRetrieveTokenResponse.parse(memory), state).not.toThrow();
          expect(() => WaitpointRetrieveTokenResponse.parse(postgres), state).not.toThrow();
          const comparable = (
            { id, url, createdAt, completedAt, ...rest }: Record<string, unknown>,
            environmentId: string
          ) => ({ ...rest, output: withMarker(rest.output, environmentId) });
          const memoryFields = comparable(memory, memoryEnv.id);
          const postgresFields = comparable(postgres, postgresEnv.id);
          // Every state created without an idempotency key: S1, S3, S4 and S5.
          if (state !== "S2" && state !== "S6") {
            expect(memoryFields).not.toHaveProperty("idempotencyKey");
            expect(postgresFields.idempotencyKey).toBe(pair.postgres.idempotencyKey);
            delete postgresFields.idempotencyKey;
          }
          expect(memoryFields, state).toEqual(postgresFields);
          if (state === "S2" || state === "S6") {
            expect(memory, state).toMatchObject({
              idempotencyKey: state === "S2" ? "customer-key" : "expiring-key",
              idempotencyKeyExpiresAt: (state === "S2" ? hourAhead : secondAhead).toISOString(),
            });
          }

          const memoryDetail = await detail.call({
            friendlyId: pair.memory.friendlyId,
            environmentId: memoryEnv.id,
            projectId: memoryEnv.project.id,
            organizationId: memoryEnv.organizationId,
          });
          const postgresDetail = await detail.call({
            friendlyId: pair.postgres.friendlyId,
            environmentId: postgresEnv.id,
            projectId: postgresEnv.project.id,
            organizationId: postgresEnv.organizationId,
          });
          const shown = (
            waitpoint: NonNullable<typeof memoryDetail>,
            environmentId: string,
            friendlyId: string
          ) => {
            expect(new URL(waitpoint.url).pathname, state).toMatch(
              new RegExp(`^/api/v1/waitpoints/tokens/${friendlyId}/callback/[^/]+$`)
            );
            return {
              type: waitpoint.type,
              status: waitpoint.status,
              idempotencyKeyExpiresAt: waitpoint.idempotencyKeyExpiresAt,
              completedAfter: waitpoint.completedAfter,
              timeoutAt: waitpoint.timeoutAt,
              tags: waitpoint.tags,
              output: withMarker(waitpoint.output, environmentId),
              outputIsError: waitpoint.outputIsError,
              outputType: state === "S1" || state === "S2" ? undefined : waitpoint.outputType,
              // As WaitpointDetailTable shows it.
              idempotencyKey: waitpoint.userProvidedIdempotencyKey
                ? (waitpoint.inactiveIdempotencyKey ?? waitpoint.idempotencyKey)
                : "–",
              connectedRuns: waitpoint.connectedRuns,
            };
          };
          expect(memoryDetail, state).not.toBeNull();
          expect(postgresDetail, state).not.toBeNull();
          const memoryShown = shown(memoryDetail!, memoryEnv.id, pair.memory.friendlyId);
          expect(memoryShown, state).toEqual(
            shown(postgresDetail!, postgresEnv.id, pair.postgres.friendlyId)
          );
          expect(memoryShown.connectedRuns, state).toEqual([]);
        }

        // Catches: retrieve reshaping a run-bound store token, which only standalone tokens get.
        const { waitpoint: runBound } = await adapter.createManualWaitpoint({
          runId: "run_bound",
          projectId: memoryEnv.project.id,
          environmentId: memoryEnv.id,
          mintContext: { organizationId: memoryEnv.organizationId },
          idempotencyKey: "run-bound-key",
        });
        const stored = await engine.getStoreDateTimeWaitpoint({
          waitpointId: runBound.id,
          environmentId: memoryEnv.id,
          projectId: memoryEnv.project.id,
          organizationId: memoryEnv.organizationId,
        });
        expect(await retrieve.call(memoryEnv, runBound.id)).toMatchObject({
          idempotencyKey: stored!.idempotencyKey,
          outputType: stored!.outputType,
        });
      } finally {
        await engine.quit();
        await store.quit();
      }
    }
  );
});
