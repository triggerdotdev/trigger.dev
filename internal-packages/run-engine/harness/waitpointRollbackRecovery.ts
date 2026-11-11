#!/usr/bin/env tsx
/** Explicit internal operator entry point. Never imported by webapp/server startup. */
import { createHash } from "node:crypto";
import { readFile, open } from "node:fs/promises";
import { parseArgs } from "node:util";
import { PrismaClient } from "@trigger.dev/database";
import runOpsDatabase from "@internal/run-ops-database";
import { resolveShard } from "@trigger.dev/core/v3/isomorphic";
import { PostgresRunStore, RoutingRunStore, type RunStore } from "@internal/run-store";
import { Redis, type RedisClient, createRedisClusterClient } from "@internal/redis";
import { z } from "zod";
import { SimpleQueue } from "@trigger.dev/redis-worker";
import { workerCatalog } from "../src/engine/workerCatalog.js";
import {
  ManualWaitpointRollbackRecovery,
  rollbackScopeSchema,
  rollbackPlanSchema,
  recoveryOperationSchema,
} from "../src/engine/waitpointCoordinator/manualRollbackRecovery.js";
import { WaitpointStoreCoordinator } from "../src/engine/waitpointCoordinator/storeCoordinator.js";

const { RunOpsPrismaClient } = runOpsDatabase;

const configSchema = z
  .object({
    deployment: z.string().min(1),
    controlPlaneUrlEnv: z.string(),
    redisUrlEnv: z.string(),
    redisCluster: z.boolean().default(true),
    workerQueue: z.object({ redisUrlEnv: z.string(), keyPrefix: z.string() }).strict().optional(),
    // Must match the deployed read topology, even while creation/split flags are off.
    runStores: z.discriminatedUnion("mode", [
      z.object({ mode: z.literal("single"), urlEnv: z.string() }).strict(),
      z
        .object({
          mode: z.literal("routed"),
          legacyUrlEnv: z.string(),
          newUrlEnv: z.string(),
          shards: z
            .array(
              z
                .object({
                  key: z.string(),
                  urlEnv: z.string().optional(),
                  aliasOf: z.literal("new").optional(),
                })
                .strict()
            )
            .max(64)
            .default([]),
        })
        .strict(),
    ]),
  })
  .strict();

async function main() {
  const { values } = parseArgs({
    options: {
      config: { type: "string" },
      scope: { type: "string" },
      discover: { type: "string" },
      source: { type: "string", multiple: true },
      operation: { type: "string" },
      plan: { type: "string" },
      out: { type: "string" },
      apply: { type: "boolean", default: false },
      verify: { type: "boolean", default: false },
      run: { type: "string", multiple: true },
      "confirm-maintenance-window": { type: "boolean", default: false },
    },
  });
  if (!values.out)
    throw new Error("An exclusive report output path is required: --out report.json");
  const output = await open(values.out, "wx", 0o600);
  const clients: Array<PrismaClient | InstanceType<typeof RunOpsPrismaClient>> = [];
  const secrets: string[] = [];
  let redis: RedisClient | undefined;
  let maintenanceQueue:
    | SimpleQueue<{
        retireManualWaitpointCatalog: typeof workerCatalog.retireManualWaitpointCatalog.schema;
      }>
    | undefined;
  let stage = "preflight";
  let report: unknown;
  try {
    try {
      if (
        !values.config ||
        (values.apply && values.verify) ||
        ((values.apply || values.verify || values.discover) && !!values.operation) ||
        (values.apply || values.verify
          ? !values.plan || !!values.scope || !!values.discover
          : (!values.scope && !values.discover) ||
            (!!values.scope && !!values.discover) ||
            !!values.plan)
      ) {
        throw new Error(
          "Usage: --config topology.json --out report.json (--scope scope.json [--operation rollback|contributions-only] | --discover cursor.json | --plan plan.json --verify | --plan plan.json --apply [--run RUN_ID] [--source SOURCE_ID] --confirm-maintenance-window)"
        );
      }
      const config = configSchema.parse(JSON.parse(await readFile(values.config!, "utf8")));
      const url = (name: string) => {
        const value = process.env[name];
        if (!value) throw new Error(`Missing connection environment variable ${name}`);
        secrets.push(value);
        return value;
      };
      const controlPlane = new PrismaClient({
        datasources: { db: { url: url(config.controlPlaneUrlEnv) } },
      });
      clients.push(controlPlane);
      const leaf = (endpoint: string, dedicated: boolean): RunStore => {
        const client = dedicated
          ? new RunOpsPrismaClient({ datasources: { db: { url: url(endpoint) } } })
          : new PrismaClient({ datasources: { db: { url: url(endpoint) } } });
        clients.push(client);
        return new PostgresRunStore({
          prisma: client,
          readOnlyPrisma: client,
          schemaVariant: dedicated ? "dedicated" : "legacy",
        });
      };
      let runStore: RunStore;
      const topology = config.runStores;
      if (topology.mode === "single") runStore = leaf(topology.urlEnv, false);
      else {
        const next = leaf(topology.newUrlEnv, true);
        runStore = new RoutingRunStore({
          new: next,
          legacy: leaf(topology.legacyUrlEnv, false),
          shards: topology.shards.map((shard) => {
            if (shard.aliasOf) {
              if (shard.urlEnv) throw new Error("Aliased shard must not supply another database");
              return { key: shard.key, store: next, aliasOf: shard.aliasOf };
            }
            if (!shard.urlEnv) throw new Error("Shard needs urlEnv or aliasOf");
            return { key: shard.key, store: leaf(shard.urlEnv, true) };
          }),
        });
      }
      const redisUrl = url(config.redisUrlEnv);
      if (config.redisCluster) {
        const endpoint = new URL(redisUrl);
        if (
          !["redis:", "rediss:"].includes(endpoint.protocol) ||
          !["", "/", "/0"].includes(endpoint.pathname) ||
          endpoint.search ||
          endpoint.hash
        )
          throw new Error("Invalid cluster endpoint");
        redis = createRedisClusterClient({
          nodes: [{ host: endpoint.hostname, port: Number(endpoint.port || 6379) }],
          clusterOptions: { scaleReads: "master" },
          redisOptions: {
            username: endpoint.username ? decodeURIComponent(endpoint.username) : undefined,
            password: endpoint.password ? decodeURIComponent(endpoint.password) : undefined,
            tls: endpoint.protocol === "rediss:" ? { servername: endpoint.hostname } : undefined,
            maxRetriesPerRequest: 1,
            commandTimeout: 5000,
            connectTimeout: 5000,
          },
        });
      } else redis = new Redis(redisUrl, { maxRetriesPerRequest: 1, commandTimeout: 5000 });
      const target = createHash("sha256")
        .update(JSON.stringify(config))
        .update(JSON.stringify(secrets))
        .digest("hex");
      const store = new WaitpointStoreCoordinator({ client: redis });
      if (config.workerQueue) {
        const endpoint = new URL(url(config.workerQueue.redisUrlEnv));
        if (
          !["redis:", "rediss:"].includes(endpoint.protocol) ||
          endpoint.search ||
          endpoint.hash ||
          !/^\/(?:[0-9]+)?$/.test(endpoint.pathname || "/")
        )
          throw new Error("Invalid worker queue endpoint");
        maintenanceQueue = new SimpleQueue({
          name: "run-engine-worker",
          schema: {
            retireManualWaitpointCatalog: workerCatalog.retireManualWaitpointCatalog.schema,
          },
          redisOptions: {
            host: endpoint.hostname,
            port: Number(endpoint.port || 6379),
            username: endpoint.username ? decodeURIComponent(endpoint.username) : undefined,
            password: endpoint.password ? decodeURIComponent(endpoint.password) : undefined,
            db: Number(endpoint.pathname.slice(1) || 0),
            tls: endpoint.protocol === "rediss:" ? { servername: endpoint.hostname } : undefined,
            keyPrefix: config.workerQueue.keyPrefix,
          },
        });
      }
      const queue = maintenanceQueue;
      const recovery = new ManualWaitpointRollbackRecovery({
        ...(queue
          ? {
              catalogMaintenance: {
                schedule: async (payload, availableAt) =>
                  queue.enqueue({
                    id: `retireManualWaitpointCatalog:${payload.waitpointId}`,
                    job: "retireManualWaitpointCatalog",
                    item: payload,
                    availableAt,
                    visibilityTimeoutMs:
                      workerCatalog.retireManualWaitpointCatalog.visibilityTimeoutMs,
                  }),
                scheduledAt: async (payload) => {
                  const job = await queue.getJob(
                    `retireManualWaitpointCatalog:${payload.waitpointId}`
                  );
                  return job?.job === "retireManualWaitpointCatalog" &&
                    job.item.waitpointId === payload.waitpointId &&
                    job.item.organizationId === payload.organizationId &&
                    job.attempt === 0 &&
                    job.timestamp.getTime() > Date.now()
                    ? job.timestamp
                    : undefined;
                },
              },
            }
          : {}),
        target,
        controlPlane,
        runStore,
        assertRunId:
          topology.mode === "single"
            ? (runId) => {
                if (resolveShard(runId) !== "legacy")
                  throw new Error(
                    "Single legacy topology cannot read a dedicated-store run; configure routed topology"
                  );
              }
            : undefined,
        redis,
        store,
      });
      if (values.apply || values.verify) {
        const plan = rollbackPlanSchema.parse(JSON.parse(await readFile(values.plan!, "utf8")));
        stage = values.apply ? "apply" : "verification";
        report = values.apply
          ? await recovery.apply(
              plan,
              values.run ?? [],
              values["confirm-maintenance-window"],
              values.source ?? []
            )
          : await recovery.verify(plan);
      } else if (values.discover) {
        const discovery = z
          .object({
            organizationId: z.string(),
            kind: z.enum(["runs", "pending-sources", "due", "quarantine"]),
            partition: z.number().int().min(0).max(15),
            after: z.object({ score: z.string(), member: z.string() }).strict().optional(),
          })
          .strict()
          .parse(JSON.parse(await readFile(values.discover, "utf8")));
        stage = "discovery";
        report = await recovery.discover(discovery);
      } else {
        const scope = rollbackScopeSchema.parse(JSON.parse(await readFile(values.scope!, "utf8")));
        const operation = recoveryOperationSchema.parse(values.operation ?? "rollback");
        stage = "inspection";
        report = await recovery.inspect(scope, operation);
      }
    } catch (error) {
      let message = error instanceof Error ? error.message : String(error);
      for (const secret of secrets) message = message.split(secret).join("[redacted]");
      report = { errors: [{ stage, error: message }] };
      process.exitCode = 1;
    }
    await output.writeFile(JSON.stringify(report, null, 2) + "\n");
    console.log(
      `Saved ${values.out}. Read the operation, coverage and unhandled list in the report.`
    );
    if (
      (report as { errors?: unknown[] }).errors?.length ||
      (report as { results?: Array<{ verified: boolean }> }).results?.some(
        (result) => !result.verified
      ) ||
      (report as { sources?: Array<{ verified: boolean }> }).sources?.some(
        (source) => !source.verified
      )
    )
      process.exitCode = 1;
  } finally {
    await output.close();
    redis?.disconnect();
    await maintenanceQueue?.close();
    await Promise.all(clients.map((client) => client.$disconnect()));
  }
}
main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
