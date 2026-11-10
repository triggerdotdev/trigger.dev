import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect } from "vitest";
import { containerTest } from "@internal/testcontainers";
import { createRedisClusterClient, createRedisClient } from "@internal/redis";
import { generateRunOpsId, generateWaitpointId } from "@trigger.dev/core/v3/isomorphic";
import {
  hasLocalRedisServer,
  startLocalRedisCluster,
} from "../../../../testcontainers/src/localRedisCluster.js";
import { setupAuthenticatedEnvironment } from "../tests/setup.js";
import { WaitpointStoreCoordinator } from "./storeCoordinator.js";
import { fanoutPartition, organizationRunIndexKey, waitpointKeys } from "./keys.js";

for (const clusterMode of [false, ...(hasLocalRedisServer() ? [true] : [])]) {
  containerTest(
    `operator CLI discovers, cleans and verifies on ${clusterMode ? "Redis Cluster" : "standalone Redis"}, and reports unsafe topology`,
    async ({ prisma, postgresContainer, redisOptions }) => {
      const cluster = clusterMode ? await startLocalRedisCluster() : undefined;
      const redis = cluster
        ? createRedisClusterClient({ nodes: cluster.nodes })
        : createRedisClient(redisOptions);
      const store = new WaitpointStoreCoordinator({ client: redis });
      const directory = await mkdtemp(join(tmpdir(), "rollback-cluster-cli-"));
      try {
        const environment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
        await prisma.organization.update({
          where: { id: environment.organizationId },
          data: { featureFlags: { waitpointStoreEnabled: false } },
        });
        const runId = "rollback_cli_terminal";
        await prisma.taskRun.create({
          data: {
            id: runId,
            friendlyId: `run_${runId}`,
            organizationId: environment.organizationId,
            projectId: environment.projectId,
            runtimeEnvironmentId: environment.id,
            engine: "V2",
            status: "CANCELED",
            annotations: { waitpointsOnStore: true },
            taskIdentifier: "task",
            payload: "{}",
            payloadType: "application/json",
            traceId: "trace",
            spanId: "span",
            queue: "task/task",
          },
        });
        const sourceId = generateWaitpointId("RUN"),
          now = new Date().toISOString();
        await store.publishRunOwnership(runId, environment.organizationId);
        await store.publishPendingSource(sourceId, environment.organizationId);
        await store.createIfAbsent({
          record: {
            id: sourceId,
            friendlyId: `waitpoint_${sourceId}`,
            type: "RUN",
            environmentId: environment.id,
            organizationId: environment.organizationId,
            projectId: environment.projectId,
            createdAt: now,
            updatedAt: now,
            completedByTaskRunId: runId,
            userProvidedIdempotencyKey: false,
            tags: [],
          },
          status: "PENDING",
        });
        await store.registerBlocks({
          runId,
          blockId: "cli-block",
          edges: [{ waitpointId: sourceId, type: "RUN", createdAt: now }],
        });
        await store.complete({
          waitpointId: sourceId,
          organizationId: environment.organizationId,
          completion: {
            completedAt: now,
            outputType: "application/json",
            outputIsError: false,
            output: null,
          },
        });
        const manualId = generateWaitpointId("MANUAL");
        const manualRecord = {
          id: manualId,
          friendlyId: `waitpoint_${manualId}`,
          type: "MANUAL" as const,
          environmentId: environment.id,
          organizationId: environment.organizationId,
          projectId: environment.projectId,
          createdAt: now,
          updatedAt: now,
          userProvidedIdempotencyKey: false,
          tags: ["cli-manual"],
        };
        await store.manualCatalog.publish(manualRecord, Date.now() + 100);
        await store.createIfAbsent({ record: manualRecord, status: "PENDING" });
        await store.complete({
          waitpointId: manualId,
          organizationId: environment.organizationId,
          completion: {
            completedAt: now,
            outputType: "application/json",
            outputIsError: false,
            output: null,
          },
        });
        const config = join(directory, "config.json"),
          scope = join(directory, "scope.json");
        await writeFile(
          config,
          JSON.stringify({
            deployment: "cluster-test",
            controlPlaneUrlEnv: "ROLLBACK_DB",
            ...(!clusterMode && { redisCluster: false }),
            redisUrlEnv: "ROLLBACK_REDIS",
            workerQueue: {
              redisUrlEnv: "ROLLBACK_WORKER_REDIS",
              keyPrefix: "rollback-cli:worker:",
            },
            runStores: { mode: "single", urlEnv: "ROLLBACK_DB" },
          })
        ); // Omit redisCluster to exercise the default.
        await writeFile(
          scope,
          JSON.stringify({
            organizationId: environment.organizationId,
            runs: [{ runId, blockIds: [], sourceIds: [sourceId, manualId] }],
          })
        );
        let invocation = 0;
        const cli = async (args: string[], succeeds = true) => {
          const out = join(directory, `report-${invocation++}.json`);
          let failed = false;
          try {
            await promisify(execFile)(
              fileURLToPath(new URL("../../../node_modules/.bin/tsx", import.meta.url)),
              [
                fileURLToPath(
                  new URL("../../../harness/waitpointRollbackRecovery.ts", import.meta.url)
                ),
                "--config",
                config,
                "--out",
                out,
                ...args,
              ],
              {
                timeout: 30000,
                env: {
                  ...process.env,
                  NODE_OPTIONS: "--conditions=@triggerdotdev/source",
                  ROLLBACK_DB: postgresContainer.getConnectionUri(),
                  ROLLBACK_WORKER_REDIS: `redis://:${encodeURIComponent(redisOptions.password ?? "")}@${redisOptions.host}:${redisOptions.port}`,
                  ROLLBACK_REDIS: cluster
                    ? `redis://127.0.0.1:${cluster.nodes[0]!.port}`
                    : `redis://:${encodeURIComponent(redisOptions.password ?? "")}@${redisOptions.host}:${redisOptions.port}`,
                },
              }
            );
          } catch (error) {
            if (succeeds) throw error;
            failed = true;
          }
          expect(failed).toBe(!succeeds);
          return { out, report: JSON.parse(await readFile(out, "utf8")) };
        };
        const inspected = await cli(["--scope", scope]);
        expect(inspected.report.entries[0].classification).toBe("terminal");
        const cursor = join(directory, "cursor.json");
        await writeFile(
          cursor,
          JSON.stringify({
            organizationId: environment.organizationId,
            kind: "pending-sources",
            partition: fanoutPartition(sourceId),
          })
        );
        const discovered = await cli(["--discover", cursor]);
        expect(
          discovered.report.plan.sources.map(
            (source: { waitpointId: string }) => source.waitpointId
          )
        ).toContain(sourceId);
        const expired = join(directory, "expired.json");
        await writeFile(
          expired,
          JSON.stringify({ ...inspected.report, expiresAt: new Date(0).toISOString() })
        );
        const rejected = await cli(
          ["--plan", expired, "--apply", "--run", runId, "--confirm-maintenance-window"],
          false
        );
        expect(rejected.report.errors).toContainEqual({
          stage: "preflight",
          error: expect.stringContaining("expired"),
        });
        expect(rejected.report.results).toEqual([]);
        expect(await redis.hlen(waitpointKeys(sourceId).watchers)).toBe(1);
        const applied = await cli([
          "--plan",
          inspected.out,
          "--apply",
          "--run",
          runId,
          "--confirm-maintenance-window",
        ]);
        expect(applied.report.results[0].verified).toBe(true);
        const verified = await cli(["--plan", inspected.out, "--verify"]);
        expect(verified.report.results[0].verified).toBe(true);
        const catalog = await store.manualCatalog.list({
          organizationId: environment.organizationId,
          environmentId: environment.id,
          statuses: ["COMPLETED"],
          direction: "forward",
          limit: 10,
        });
        expect(catalog.map((item) => item.record.id)).toContain(manualId);
        expect(await redis.pttl(waitpointKeys(sourceId).record)).toBeGreaterThan(0);
        expect(await redis.hlen(waitpointKeys(sourceId).watchers)).toBe(0);
        // Registry ownership must not turn a lookup in the wrong database into abandonment.
        const routedId = generateRunOpsId();
        await store.publishRunOwnership(routedId, environment.organizationId);
        await writeFile(
          scope,
          JSON.stringify({
            organizationId: environment.organizationId,
            runs: [{ runId: routedId, blockIds: [] }],
          })
        );
        const refused = await cli(["--scope", scope], false);
        expect(refused.report.errors).toContainEqual({
          stage: "inspection",
          error: expect.stringContaining("Single legacy topology"),
        });
        expect(
          await redis.zscore(
            organizationRunIndexKey(environment.organizationId, fanoutPartition(routedId)),
            routedId
          )
        ).not.toBeNull();
      } finally {
        await store.quit();
        await cluster?.stop();
        await rm(directory, { recursive: true, force: true });
      }
    }
  );
}
