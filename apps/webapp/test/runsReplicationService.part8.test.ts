import { ClickHouse } from "@internal/clickhouse";
import { createPostgresContainer, replicationContainerTest } from "@internal/testcontainers";
import { PrismaClient, type TaskRunStatus as TaskRunStatusType } from "@trigger.dev/database";
import { setTimeout } from "node:timers/promises";
import { z } from "zod";
import { TaskRunStatus } from "~/database-types";
import { RunsReplicationService } from "~/services/runsReplicationService.server";
import { createInMemoryTracing } from "./utils/tracing";
import { TestReplicationClickhouseFactory } from "./utils/testReplicationClickhouseFactory";

vi.setConfig({ testTimeout: 60_000 });

describe("RunsReplicationService (part 8/8) - dual-source dedup", () => {
  replicationContainerTest(
    "collapses the same run from two slots into one ClickHouse row, gen-1 wins across the PG14<->PG17 boundary",
    async ({ clickhouseContainer, redisOptions, postgresContainer, prisma, network }) => {
      // LEGACY / gen-0 source = the fixture's PG14 container.
      const legacyUrl = postgresContainer.getConnectionUri();

      // NEW / gen-1 source = a dedicated PG17 container on the SAME network.
      // createPostgresContainer applies wal_level=logical and pushes the TaskRun schema.
      const { url: newUrl, container: pg17 } = await createPostgresContainer(network, {
        imageTag: "docker.io/postgres:17",
      });

      const clickhouse = new ClickHouse({
        url: clickhouseContainer.getConnectionUrl(),
        name: "runs-replication",
        logLevel: "warn",
      });

      const { tracer } = createInMemoryTracing();

      let runsReplicationService: RunsReplicationService | undefined;

      try {
        // REPLICA IDENTITY FULL on BOTH source DBs before start().
        await prisma.$executeRawUnsafe(`ALTER TABLE public."TaskRun" REPLICA IDENTITY FULL;`);

        const newPrismaForAlter = new PrismaClient({
          datasources: { db: { url: newUrl } },
        });
        try {
          await newPrismaForAlter.$executeRawUnsafe(
            `ALTER TABLE public."TaskRun" REPLICA IDENTITY FULL;`
          );
        } finally {
          await newPrismaForAlter.$disconnect();
        }

        runsReplicationService = new RunsReplicationService({
          clickhouseFactory: new TestReplicationClickhouseFactory(clickhouse),
          serviceName: "runs-replication",
          redisOptions,
          sources: [
            {
              id: "legacy",
              pgConnectionUrl: legacyUrl,
              slotName: "tr_legacy_v1",
              publicationName: "tr_legacy_v1_pub",
              originGeneration: 0,
            },
            {
              id: "new",
              pgConnectionUrl: newUrl,
              slotName: "tr_new_v1",
              publicationName: "tr_new_v1_pub",
              originGeneration: 1,
            },
          ],
          maxFlushConcurrency: 1,
          flushIntervalMs: 100,
          flushBatchSize: 1,
          leaderLockTimeoutMs: 5000,
          leaderLockExtendIntervalMs: 1000,
          ackIntervalSeconds: 5,
          tracer,
          logLevel: "warn",
        });

        await runsReplicationService.start();

        // The ClickHouse ReplacingMergeTree dedup key is the full ORDER BY tuple
        // (organization_id, project_id, environment_id, created_at, run_id) - NOT run_id alone.
        // So the two source rows must share ALL of those columns to collapse into one. We give
        // both DBs identical org/project/env/run ids and an identical createdAt.
        const suffix = `${Date.now()}`;
        const sharedOrgId = `org_dual_${suffix}`;
        const sharedProjectId = `proj_dual_${suffix}`;
        const sharedEnvId = `env_dual_${suffix}`;
        const sharedRunId = `run_dual_${suffix}`;
        const sharedCreatedAt = new Date();

        const newPrisma = new PrismaClient({ datasources: { db: { url: newUrl } } });

        const seedFkRows = async (
          client: PrismaClient,
          tag: string,
          status: TaskRunStatusType,
          friendlyId: string
        ) => {
          await client.organization.create({
            data: { id: sharedOrgId, title: `org-${tag}`, slug: `org-${tag}` },
          });
          await client.project.create({
            data: {
              id: sharedProjectId,
              name: `proj-${tag}`,
              slug: `proj-${tag}`,
              organizationId: sharedOrgId,
              externalRef: `proj-${tag}`,
            },
          });
          await client.runtimeEnvironment.create({
            data: {
              id: sharedEnvId,
              slug: `env-${tag}`,
              type: "DEVELOPMENT",
              projectId: sharedProjectId,
              organizationId: sharedOrgId,
              apiKey: `apikey-${tag}`,
              pkApiKey: `pkapikey-${tag}`,
              shortcode: `shortcode-${tag}`,
            },
          });
          await client.taskRun.create({
            data: {
              id: sharedRunId,
              friendlyId,
              taskIdentifier: "my-task",
              payload: JSON.stringify({ foo: "bar" }),
              traceId: `trace-${tag}`,
              spanId: `span-${tag}`,
              queue: "test",
              status,
              createdAt: sharedCreatedAt,
              runtimeEnvironmentId: sharedEnvId,
              projectId: sharedProjectId,
              organizationId: sharedOrgId,
              environmentType: "DEVELOPMENT",
              engine: "V2",
            },
          });
        };

        // The two source servers have INDEPENDENT WAL counters, so commit order alone does not
        // control raw LSN magnitude. To make legacy's raw LSN deterministically larger we burn WAL
        // on the legacy server with pg_switch_wal() (each call bumps the WAL segment = the high 32
        // bits of the LSN) before inserting the legacy run. With raw LSN as _version the larger-LSN
        // STALE legacy PENDING snapshot would win the dedup - which is the RED this guards against.
        try {
          await seedFkRows(newPrisma, "new", TaskRunStatus.COMPLETED_SUCCESSFULLY, "run_dual_new");

          // Settle so the new DB's WAL entry is produced (and committed) before the legacy one.
          await setTimeout(500);

          for (let i = 0; i < 16; i++) {
            await prisma.$executeRawUnsafe(`SELECT pg_switch_wal();`);
          }

          await seedFkRows(prisma, "legacy", TaskRunStatus.PENDING, "run_dual_legacy");

          // Wait for BOTH streams to flush into ClickHouse.
          await setTimeout(3000);
        } finally {
          await newPrisma.$disconnect();
        }

        const queryRuns = clickhouse.reader.query({
          name: "dual-source",
          query:
            "SELECT run_id, status, count() OVER () AS total FROM trigger_dev.task_runs_v2 FINAL",
          schema: z.object({
            run_id: z.string(),
            status: z.string(),
            total: z.number().int(),
          }),
        });

        const [queryError, result] = await queryRuns({});

        expect(queryError).toBeNull();
        expect(result).toHaveLength(1);
        expect(result?.[0]).toEqual(
          expect.objectContaining({
            run_id: sharedRunId,
            status: "COMPLETED_SUCCESSFULLY",
          })
        );
      } finally {
        await runsReplicationService?.stop();
        await pg17.stop({ timeout: 0 });
      }
    }
  );

  // Case A - reverse-order independence.
  // Same run in both sources, but we flush the NEW (gen-1) snapshot FIRST, then the LEGACY
  // (gen-0) snapshot. The gen-1 winner must survive regardless of arrival order - the collapse
  // is FINAL-time and ordered by _version (composed origin generation), not by arrival time.
  replicationContainerTest(
    "gen-1 winner survives when the new snapshot flushes before the legacy snapshot (reverse-order independence)",
    async ({ clickhouseContainer, redisOptions, postgresContainer, prisma, network }) => {
      const legacyUrl = postgresContainer.getConnectionUri();

      const { url: newUrl, container: pg17 } = await createPostgresContainer(network, {
        imageTag: "docker.io/postgres:17",
      });

      const clickhouse = new ClickHouse({
        url: clickhouseContainer.getConnectionUrl(),
        name: "runs-replication",
        logLevel: "warn",
      });

      const { tracer } = createInMemoryTracing();

      let runsReplicationService: RunsReplicationService | undefined;

      try {
        await prisma.$executeRawUnsafe(`ALTER TABLE public."TaskRun" REPLICA IDENTITY FULL;`);

        const newPrismaForAlter = new PrismaClient({
          datasources: { db: { url: newUrl } },
        });
        try {
          await newPrismaForAlter.$executeRawUnsafe(
            `ALTER TABLE public."TaskRun" REPLICA IDENTITY FULL;`
          );
        } finally {
          await newPrismaForAlter.$disconnect();
        }

        runsReplicationService = new RunsReplicationService({
          clickhouseFactory: new TestReplicationClickhouseFactory(clickhouse),
          serviceName: "runs-replication",
          redisOptions,
          sources: [
            {
              id: "legacy",
              pgConnectionUrl: legacyUrl,
              slotName: "tr_legacy_a",
              publicationName: "tr_legacy_a_pub",
              originGeneration: 0,
            },
            {
              id: "new",
              pgConnectionUrl: newUrl,
              slotName: "tr_new_a",
              publicationName: "tr_new_a_pub",
              originGeneration: 1,
            },
          ],
          maxFlushConcurrency: 1,
          flushIntervalMs: 100,
          flushBatchSize: 1,
          leaderLockTimeoutMs: 5000,
          leaderLockExtendIntervalMs: 1000,
          ackIntervalSeconds: 5,
          tracer,
          logLevel: "warn",
        });

        await runsReplicationService.start();

        const suffix = `a_${Date.now()}`;
        const sharedOrgId = `org_dual_${suffix}`;
        const sharedProjectId = `proj_dual_${suffix}`;
        const sharedEnvId = `env_dual_${suffix}`;
        const sharedRunId = `run_dual_${suffix}`;
        const sharedCreatedAt = new Date();

        const newPrisma = new PrismaClient({ datasources: { db: { url: newUrl } } });

        const seedFkRows = async (
          client: PrismaClient,
          tag: string,
          status: TaskRunStatusType,
          friendlyId: string
        ) => {
          await client.organization.create({
            data: { id: sharedOrgId, title: `org-${tag}`, slug: `org-${tag}` },
          });
          await client.project.create({
            data: {
              id: sharedProjectId,
              name: `proj-${tag}`,
              slug: `proj-${tag}`,
              organizationId: sharedOrgId,
              externalRef: `proj-${tag}`,
            },
          });
          await client.runtimeEnvironment.create({
            data: {
              id: sharedEnvId,
              slug: `env-${tag}`,
              type: "DEVELOPMENT",
              projectId: sharedProjectId,
              organizationId: sharedOrgId,
              apiKey: `apikey-${tag}`,
              pkApiKey: `pkapikey-${tag}`,
              shortcode: `shortcode-${tag}`,
            },
          });
          await client.taskRun.create({
            data: {
              id: sharedRunId,
              friendlyId,
              taskIdentifier: "my-task",
              payload: JSON.stringify({ foo: "bar" }),
              traceId: `trace-${tag}`,
              spanId: `span-${tag}`,
              queue: "test",
              status,
              createdAt: sharedCreatedAt,
              runtimeEnvironmentId: sharedEnvId,
              projectId: sharedProjectId,
              organizationId: sharedOrgId,
              environmentType: "DEVELOPMENT",
              engine: "V2",
            },
          });
        };

        try {
          // Flush the NEW (gen-1, COMPLETED) snapshot FIRST and let it land in ClickHouse.
          await seedFkRows(newPrisma, "new", TaskRunStatus.COMPLETED_SUCCESSFULLY, "run_dual_new");
          await setTimeout(2000);

          // THEN flush the LEGACY (gen-0, PENDING) snapshot.
          await seedFkRows(prisma, "legacy", TaskRunStatus.PENDING, "run_dual_legacy");
          await setTimeout(3000);
        } finally {
          await newPrisma.$disconnect();
        }

        const queryRuns = clickhouse.reader.query({
          name: "dual-source-reverse",
          query:
            "SELECT run_id, status, count() OVER () AS total FROM trigger_dev.task_runs_v2 FINAL",
          schema: z.object({
            run_id: z.string(),
            status: z.string(),
            total: z.number().int(),
          }),
        });

        const [queryError, result] = await queryRuns({});

        expect(queryError).toBeNull();
        expect(result).toHaveLength(1);
        expect(result?.[0]).toEqual(
          expect.objectContaining({
            run_id: sharedRunId,
            status: "COMPLETED_SUCCESSFULLY",
          })
        );
      } finally {
        await runsReplicationService?.stop();
        await pg17.stop({ timeout: 0 });
      }
    }
  );

  // Case B - per-source independence / no cross-contamination.
  // Two DIFFERENT runs: run X lives ONLY in the legacy/gen-0 DB, run Y lives ONLY in the
  // new/gen-1 DB. BOTH must appear in ClickHouse exactly once with their own status. This proves
  // (a) BOTH sources became leader and streamed (a single-leader regression would drop one run),
  // and (b) the two streams don't corrupt each other's per-source transaction/LSN state.
  replicationContainerTest(
    "streams two distinct runs from two sources independently without cross-contamination",
    async ({ clickhouseContainer, redisOptions, postgresContainer, prisma, network }) => {
      const legacyUrl = postgresContainer.getConnectionUri();

      const { url: newUrl, container: pg17 } = await createPostgresContainer(network, {
        imageTag: "docker.io/postgres:17",
      });

      const clickhouse = new ClickHouse({
        url: clickhouseContainer.getConnectionUrl(),
        name: "runs-replication",
        logLevel: "warn",
      });

      const { tracer } = createInMemoryTracing();

      let runsReplicationService: RunsReplicationService | undefined;

      try {
        await prisma.$executeRawUnsafe(`ALTER TABLE public."TaskRun" REPLICA IDENTITY FULL;`);

        const newPrismaForAlter = new PrismaClient({
          datasources: { db: { url: newUrl } },
        });
        try {
          await newPrismaForAlter.$executeRawUnsafe(
            `ALTER TABLE public."TaskRun" REPLICA IDENTITY FULL;`
          );
        } finally {
          await newPrismaForAlter.$disconnect();
        }

        runsReplicationService = new RunsReplicationService({
          clickhouseFactory: new TestReplicationClickhouseFactory(clickhouse),
          serviceName: "runs-replication",
          redisOptions,
          sources: [
            {
              id: "legacy",
              pgConnectionUrl: legacyUrl,
              slotName: "tr_legacy_b",
              publicationName: "tr_legacy_b_pub",
              originGeneration: 0,
            },
            {
              id: "new",
              pgConnectionUrl: newUrl,
              slotName: "tr_new_b",
              publicationName: "tr_new_b_pub",
              originGeneration: 1,
            },
          ],
          maxFlushConcurrency: 1,
          flushIntervalMs: 100,
          flushBatchSize: 1,
          leaderLockTimeoutMs: 5000,
          leaderLockExtendIntervalMs: 1000,
          ackIntervalSeconds: 5,
          tracer,
          logLevel: "warn",
        });

        await runsReplicationService.start();

        // Run X (legacy-only) and run Y (new-only) get DISTINCT ids. Each lives in its own DB
        // with its own org/project/env, so there is nothing to collapse - both must survive.
        const suffix = `b_${Date.now()}`;
        const legacyRunId = `run_legacy_only_${suffix}`;
        const newRunId = `run_new_only_${suffix}`;

        const newPrisma = new PrismaClient({ datasources: { db: { url: newUrl } } });

        const seedRun = async (
          client: PrismaClient,
          tag: string,
          runId: string,
          status: TaskRunStatusType
        ) => {
          const orgId = `org_${tag}_${suffix}`;
          const projectId = `proj_${tag}_${suffix}`;
          const envId = `env_${tag}_${suffix}`;

          await client.organization.create({
            data: { id: orgId, title: `org-${tag}`, slug: `org-${tag}-${suffix}` },
          });
          await client.project.create({
            data: {
              id: projectId,
              name: `proj-${tag}`,
              slug: `proj-${tag}-${suffix}`,
              organizationId: orgId,
              externalRef: `proj-${tag}-${suffix}`,
            },
          });
          await client.runtimeEnvironment.create({
            data: {
              id: envId,
              slug: `env-${tag}`,
              type: "DEVELOPMENT",
              projectId: projectId,
              organizationId: orgId,
              apiKey: `apikey-${tag}-${suffix}`,
              pkApiKey: `pkapikey-${tag}-${suffix}`,
              shortcode: `shortcode-${tag}-${suffix}`,
            },
          });
          await client.taskRun.create({
            data: {
              id: runId,
              friendlyId: `friendly-${runId}`,
              taskIdentifier: "my-task",
              payload: JSON.stringify({ foo: "bar" }),
              traceId: `trace-${tag}-${suffix}`,
              spanId: `span-${tag}-${suffix}`,
              queue: "test",
              status,
              createdAt: new Date(),
              runtimeEnvironmentId: envId,
              projectId: projectId,
              organizationId: orgId,
              environmentType: "DEVELOPMENT",
              engine: "V2",
            },
          });
        };

        try {
          // Seed run X ONLY in legacy and run Y ONLY in new.
          await seedRun(prisma, "legacy", legacyRunId, TaskRunStatus.PENDING);
          await seedRun(newPrisma, "new", newRunId, TaskRunStatus.COMPLETED_SUCCESSFULLY);

          // Wait for BOTH streams to flush into ClickHouse.
          await setTimeout(3000);
        } finally {
          await newPrisma.$disconnect();
        }

        const queryRuns = clickhouse.reader.query({
          name: "dual-source-independent",
          query: "SELECT run_id, status FROM trigger_dev.task_runs_v2 FINAL ORDER BY run_id",
          schema: z.object({
            run_id: z.string(),
            status: z.string(),
          }),
        });

        const [queryError, result] = await queryRuns({});

        expect(queryError).toBeNull();
        expect(result).toHaveLength(2);

        const byRunId = new Map(result?.map((row) => [row.run_id, row.status]));
        expect(byRunId.get(legacyRunId)).toBe("PENDING");
        expect(byRunId.get(newRunId)).toBe("COMPLETED_SUCCESSFULLY");
      } finally {
        await runsReplicationService?.stop();
        await pg17.stop({ timeout: 0 });
      }
    }
  );
});
