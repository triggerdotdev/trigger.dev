import { ClickHouse } from "@internal/clickhouse";
import { createPostgresContainer, replicationContainerTest } from "@internal/testcontainers";
import { PrismaClient } from "@trigger.dev/database";
import Redis from "ioredis";
import { setTimeout } from "node:timers/promises";
import { z } from "zod";
import {
  assertReplicationCoversSplit,
  buildReplicationSources,
  SplitReplicationMisconfiguredError,
} from "~/services/runsReplicationInstance.server";
import { RunsReplicationService } from "~/services/runsReplicationService.server";
import { createInMemoryTracing } from "./utils/tracing";
import { TestReplicationClickhouseFactory } from "./utils/testReplicationClickhouseFactory";

vi.setConfig({ testTimeout: 90_000 });

describe("buildReplicationSources (pure)", () => {
  const baseArgs = {
    legacyUrl: "postgres://legacy",
    legacySlotName: "task_runs_to_clickhouse_v1",
    legacyPublicationName: "task_runs_to_clickhouse_v1_publication",
    legacyOriginGeneration: 0,
    newSlotName: "task_runs_to_clickhouse_v2",
    newPublicationName: "task_runs_to_clickhouse_v2_publication",
    newOriginGeneration: 1,
  };

  it("returns [legacy] when split is disabled", () => {
    const sources = buildReplicationSources({
      ...baseArgs,
      splitEnabled: false,
      newUrl: "postgres://new",
      newSourceOverride: true,
    });

    expect(sources).toHaveLength(1);
    expect(sources[0]).toEqual({
      id: "legacy",
      pgConnectionUrl: "postgres://legacy",
      slotName: "task_runs_to_clickhouse_v1",
      publicationName: "task_runs_to_clickhouse_v1_publication",
      originGeneration: 0,
    });
  });

  it("returns [legacy] when split is enabled but no new URL is set", () => {
    const sources = buildReplicationSources({
      ...baseArgs,
      splitEnabled: true,
      newUrl: undefined,
    });

    expect(sources).toHaveLength(1);
    expect(sources[0].id).toBe("legacy");
  });

  it("returns [legacy] when split + new URL but the new source is explicitly disabled (escape hatch)", () => {
    const sources = buildReplicationSources({
      ...baseArgs,
      splitEnabled: true,
      newUrl: "postgres://new",
      newSourceOverride: false,
    });

    expect(sources).toHaveLength(1);
    expect(sources[0].id).toBe("legacy");
  });

  it("returns [legacy(gen0), new(gen1)] with distinct slot/publication/generation when all gates pass", () => {
    const sources = buildReplicationSources({
      ...baseArgs,
      splitEnabled: true,
      newUrl: "postgres://new",
    });

    expect(sources).toHaveLength(2);
    expect(sources[0]).toEqual({
      id: "legacy",
      pgConnectionUrl: "postgres://legacy",
      slotName: "task_runs_to_clickhouse_v1",
      publicationName: "task_runs_to_clickhouse_v1_publication",
      originGeneration: 0,
    });
    expect(sources[1]).toEqual({
      id: "new",
      pgConnectionUrl: "postgres://new",
      slotName: "task_runs_to_clickhouse_v2",
      publicationName: "task_runs_to_clickhouse_v2_publication",
      originGeneration: 1,
    });

    // Distinctness invariants the service validates.
    expect(sources[0].slotName).not.toBe(sources[1].slotName);
    expect(sources[0].publicationName).not.toBe(sources[1].publicationName);
    expect(sources[0].originGeneration).not.toBe(sources[1].originGeneration);
  });

  it("returns [legacy, new] when split is enabled + new URL is set WITHOUT any RUN_REPLICATION_NEW_ENABLED override", () => {
    const sources = buildReplicationSources({
      ...baseArgs,
      splitEnabled: true,
      newUrl: "postgres://new",
    });

    expect(sources).toHaveLength(2);
    expect(sources[0].id).toBe("legacy");
    expect(sources[1]).toEqual({
      id: "new",
      pgConnectionUrl: "postgres://new",
      slotName: "task_runs_to_clickhouse_v2",
      publicationName: "task_runs_to_clickhouse_v2_publication",
      originGeneration: 1,
    });
  });

  it("treats newSourceOverride:false as an explicit escape hatch (force the new source off even under split)", () => {
    const sources = buildReplicationSources({
      ...baseArgs,
      splitEnabled: true,
      newUrl: "postgres://new",
      newSourceOverride: false,
    });

    expect(sources).toHaveLength(1);
    expect(sources[0].id).toBe("legacy");
  });

  it("new source pgConnectionUrl === the provided RUN_OPS_DATABASE_URL", () => {
    const runOpsUrl = "postgres://run-ops-dedicated";

    const sources = buildReplicationSources({
      ...baseArgs,
      splitEnabled: true,
      newUrl: runOpsUrl,
    });

    expect(sources).toHaveLength(2);
    expect(sources[1]!.id).toBe("new");
    expect(sources[1]!.pgConnectionUrl).toBe(runOpsUrl);
  });
});

describe("assertReplicationCoversSplit (boot gate-coupling)", () => {
  const baseArgs = {
    legacyUrl: "postgres://legacy",
    legacySlotName: "task_runs_to_clickhouse_v1",
    legacyPublicationName: "task_runs_to_clickhouse_v1_publication",
    legacyOriginGeneration: 0,
    newSlotName: "task_runs_to_clickhouse_v2",
    newPublicationName: "task_runs_to_clickhouse_v2_publication",
    newOriginGeneration: 1,
  };

  it('throws when split is on but sources[] has no "new" source (the silent under-count)', () => {
    // Split on, but the new replication source is forced off — run-ops runs would not
    // reach ClickHouse. This is the exact misconfiguration the boot gate must refuse to boot with.
    const sources = buildReplicationSources({
      ...baseArgs,
      splitEnabled: true,
      newUrl: "postgres://new",
      newSourceOverride: false,
    });
    expect(sources.some((s) => s.id === "new")).toBe(false);

    expect(() => assertReplicationCoversSplit({ splitEnabled: true, sources })).toThrow(
      SplitReplicationMisconfiguredError
    );
  });

  it("throws when split is on but split has a new URL missing entirely", () => {
    const sources = buildReplicationSources({
      ...baseArgs,
      splitEnabled: true,
      newUrl: undefined,
    });

    expect(() => assertReplicationCoversSplit({ splitEnabled: true, sources })).toThrow(
      SplitReplicationMisconfiguredError
    );
  });

  it("does NOT throw when split is on and the new source is present", () => {
    const sources = buildReplicationSources({
      ...baseArgs,
      splitEnabled: true,
      newUrl: "postgres://new",
    });
    expect(sources.some((s) => s.id === "new")).toBe(true);

    expect(() => assertReplicationCoversSplit({ splitEnabled: true, sources })).not.toThrow();
  });

  it("does NOT throw when split is off (legacy-only is the correct config)", () => {
    const sources = buildReplicationSources({
      ...baseArgs,
      splitEnabled: false,
      newUrl: "postgres://new",
    });

    expect(() => assertReplicationCoversSplit({ splitEnabled: false, sources })).not.toThrow();
  });
});

describe("replication sources at N shards", () => {
  const baseArgs = {
    legacyUrl: "postgres://legacy",
    legacySlotName: "task_runs_to_clickhouse_v1",
    legacyPublicationName: "task_runs_to_clickhouse_v1_publication",
    legacyOriginGeneration: 0,
    newSlotName: "task_runs_to_clickhouse_v2",
    newPublicationName: "task_runs_to_clickhouse_v2_publication",
    newOriginGeneration: 1,
    splitEnabled: true,
    newUrl: "postgres://new",
  };

  const shardA = {
    key: "a",
    url: "postgres://shard-a",
    replication: {
      slotName: "task_runs_to_clickhouse_shard_a",
      publicationName: "task_runs_to_clickhouse_shard_a_publication",
      originGeneration: 2,
    },
  };
  const shardB = {
    key: "b",
    url: "postgres://shard-b",
    replication: {
      slotName: "task_runs_to_clickhouse_shard_b",
      publicationName: "task_runs_to_clickhouse_shard_b_publication",
      originGeneration: 3,
    },
  };

  it("appends nothing when no shard is configured", () => {
    const sources = buildReplicationSources({ ...baseArgs, shards: [] });
    expect(sources.map((s) => s.id)).toEqual(["legacy", "new"]);
  });

  it("appends one source per shard, after legacy and new", () => {
    const sources = buildReplicationSources({ ...baseArgs, shards: [shardA, shardB] });
    expect(sources.map((s) => s.id)).toEqual(["legacy", "new", "shard-a", "shard-b"]);
    expect(sources[2]).toEqual({
      id: "shard-a",
      pgConnectionUrl: "postgres://shard-a",
      slotName: "task_runs_to_clickhouse_shard_a",
      publicationName: "task_runs_to_clickhouse_shard_a_publication",
      originGeneration: 2,
    });
  });

  it("appends no shard source when the new source is off, because split is the precondition", () => {
    const sources = buildReplicationSources({
      ...baseArgs,
      splitEnabled: false,
      shards: [shardA],
    });
    expect(sources.map((s) => s.id)).toEqual(["legacy"]);
  });

  it("throws when a shard that owns its database has no source", () => {
    const sources = buildReplicationSources({ ...baseArgs, shards: [] });
    expect(() =>
      assertReplicationCoversSplit({
        splitEnabled: true,
        sources,
        shards: [{ key: "a" }],
      })
    ).toThrow(SplitReplicationMisconfiguredError);
  });

  it("names the uncovered shard in the message", () => {
    const sources = buildReplicationSources({ ...baseArgs, shards: [shardA] });
    expect(() =>
      assertReplicationCoversSplit({
        splitEnabled: true,
        sources,
        shards: [{ key: "a" }, { key: "b" }],
      })
    ).toThrow(/shard b/i);
  });

  it("does NOT throw when every shard has its own source", () => {
    const sources = buildReplicationSources({ ...baseArgs, shards: [shardA, shardB] });
    expect(() =>
      assertReplicationCoversSplit({
        splitEnabled: true,
        sources,
        shards: [{ key: "a" }, { key: "b" }],
      })
    ).not.toThrow();
  });

  it("does NOT require a source for an aliased shard, because its target's slot covers it", () => {
    const sources = buildReplicationSources({ ...baseArgs, shards: [] });
    expect(() =>
      assertReplicationCoversSplit({
        splitEnabled: true,
        sources,
        shards: [{ key: "z", aliasOf: "new" }],
      })
    ).not.toThrow();
  });

  it("does NOT check shard coverage when split is off", () => {
    const sources = buildReplicationSources({ ...baseArgs, splitEnabled: false, shards: [] });
    expect(() =>
      assertReplicationCoversSplit({
        splitEnabled: false,
        sources,
        shards: [{ key: "a" }],
      })
    ).not.toThrow();
  });

  // The catch site keys on `instanceof SplitReplicationMisconfiguredError` to reach
  // process.exit(1). A shard with no replication must reach the same exit.
  it("raises an error the existing exit path recognizes", () => {
    try {
      assertReplicationCoversSplit({
        splitEnabled: true,
        sources: buildReplicationSources({ ...baseArgs, shards: [] }),
        shards: [{ key: "a" }],
      });
      expect.unreachable("expected a throw");
    } catch (error) {
      expect(error).toBeInstanceOf(SplitReplicationMisconfiguredError);
    }
  });

  // F1 class: the descriptor parser checks uniqueness AMONG shards only. It cannot see the
  // env-configured legacy and new sources, so a shard can collide with them. The service's own
  // check throws too late: the caller has already shut the bootstrap instance down, so the throw
  // leaves the process up with NO replication at all. These must fail at the fatal boot gate.
  it("throws when a shard's slot name collides with the gen-1 new slot", () => {
    const sources = buildReplicationSources({
      ...baseArgs,
      shards: [
        { ...shardA, replication: { ...shardA.replication, slotName: baseArgs.newSlotName } },
      ],
    });
    expect(() =>
      assertReplicationCoversSplit({ splitEnabled: true, sources, shards: [{ key: "a" }] })
    ).toThrow(SplitReplicationMisconfiguredError);
  });

  it("throws when a shard's origin generation collides with the gen-1 new generation", () => {
    const sources = buildReplicationSources({
      ...baseArgs,
      newOriginGeneration: 2,
      shards: [shardA],
    });
    expect(() =>
      assertReplicationCoversSplit({ splitEnabled: true, sources, shards: [{ key: "a" }] })
    ).toThrow(SplitReplicationMisconfiguredError);
  });

  it("throws when a shard's publication name collides with the legacy publication", () => {
    const sources = buildReplicationSources({
      ...baseArgs,
      shards: [
        {
          ...shardA,
          replication: { ...shardA.replication, publicationName: baseArgs.legacyPublicationName },
        },
      ],
    });
    expect(() =>
      assertReplicationCoversSplit({ splitEnabled: true, sources, shards: [{ key: "a" }] })
    ).toThrow(SplitReplicationMisconfiguredError);
  });

  it("names the colliding field in the message", () => {
    const sources = buildReplicationSources({
      ...baseArgs,
      shards: [
        { ...shardA, replication: { ...shardA.replication, slotName: baseArgs.newSlotName } },
      ],
    });
    expect(() =>
      assertReplicationCoversSplit({ splitEnabled: true, sources, shards: [{ key: "a" }] })
    ).toThrow(/slotName/);
  });

  it("does NOT throw when every shard's slot, publication and generation are its own", () => {
    const sources = buildReplicationSources({ ...baseArgs, shards: [shardA, shardB] });
    expect(() =>
      assertReplicationCoversSplit({
        splitEnabled: true,
        sources,
        shards: [{ key: "a" }, { key: "b" }],
      })
    ).not.toThrow();
  });

  // The service validates sources before it builds a single replication client, so this needs no
  // container. RunsReplicationService itself is untouched by this change: the check already exists.
  it("rejects two shards that share an origin generation, via the service's own check", () => {
    const sources = buildReplicationSources({
      ...baseArgs,
      shards: [shardA, { ...shardB, replication: { ...shardB.replication, originGeneration: 2 } }],
    });

    expect(
      () =>
        new RunsReplicationService({
          clickhouseFactory: new TestReplicationClickhouseFactory(
            new ClickHouse({ url: "http://127.0.0.1:1", name: "unused", logLevel: "warn" })
          ),
          serviceName: "runs-replication",
          pgConnectionUrl: "postgres://legacy",
          slotName: "unused",
          publicationName: "unused",
          redisOptions: { host: "127.0.0.1", port: 1 },
          sources,
          logLevel: "warn",
        })
    ).toThrow(/duplicate originGeneration/i);
  });
});

describe("RunsReplication new-source backfill origin generation (integration)", () => {
  replicationContainerTest(
    "backfill via the new source tags the ClickHouse row with the new origin generation (gen=1), not gen=0",
    async ({ clickhouseContainer, redisOptions, postgresContainer, prisma, network }) => {
      const legacyUrl = postgresContainer.getConnectionUri();

      const { url: newUrl, container: pg17 } = await createPostgresContainer(network, {
        imageTag: "docker.io/postgres:17",
      });

      const clickhouse = new ClickHouse({
        url: clickhouseContainer.getConnectionUrl(),
        name: "runs-replication-backfill-gen",
        logLevel: "warn",
      });

      const NEW_ORIGIN_GENERATION = 1;

      const sources = buildReplicationSources({
        splitEnabled: true,
        legacyUrl,
        newUrl,
        newSourceOverride: true,
        legacySlotName: "tr_bf_legacy",
        legacyPublicationName: "tr_bf_legacy_pub",
        legacyOriginGeneration: 0,
        newSlotName: "tr_bf_new",
        newPublicationName: "tr_bf_new_pub",
        newOriginGeneration: NEW_ORIGIN_GENERATION,
      });

      const service = new RunsReplicationService({
        clickhouseFactory: new TestReplicationClickhouseFactory(clickhouse),
        serviceName: "runs-replication-backfill-gen",
        pgConnectionUrl: legacyUrl,
        slotName: "tr_bf_legacy",
        publicationName: "tr_bf_legacy_pub",
        redisOptions: { ...redisOptions, keyPrefix: "runs-replication-backfill-gen:" },
        sources,
        maxFlushConcurrency: 1,
        flushIntervalMs: 100,
        flushBatchSize: 10,
        leaderLockTimeoutMs: 5000,
        leaderLockExtendIntervalMs: 1000,
        ackIntervalSeconds: 5,
        logLevel: "warn",
      });

      // Create org/project/env/run on the legacy DB (the FK schema lives there).
      // This simulates a pre-existing run that was migrated to the dedicated DB.
      const organization = await prisma.organization.create({
        data: { title: "bf-gen", slug: "bf-gen" },
      });
      const project = await prisma.project.create({
        data: {
          name: "bf-gen",
          slug: "bf-gen",
          organizationId: organization.id,
          externalRef: "bf-gen",
        },
      });
      const runtimeEnvironment = await prisma.runtimeEnvironment.create({
        data: {
          slug: "bf-gen",
          type: "DEVELOPMENT",
          projectId: project.id,
          organizationId: organization.id,
          apiKey: "bf-gen",
          pkApiKey: "bf-gen",
          shortcode: "bf-gen",
        },
      });

      const run = await prisma.taskRun.create({
        data: {
          friendlyId: `run_newdb_${Date.now()}`,
          taskIdentifier: "new-db-task",
          payload: JSON.stringify({ source: "dedicated-db" }),
          traceId: "bf-gen-trace",
          spanId: "bf-gen-span",
          queue: "bf-gen",
          runtimeEnvironmentId: runtimeEnvironment.id,
          projectId: project.id,
          organizationId: organization.id,
          environmentType: "DEVELOPMENT",
          engine: "V2",
          status: "COMPLETED_SUCCESSFULLY",
        },
      });

      try {
        // Backfill the run via the "new" source — must encode gen=1 in _version.
        await service.backfill([{ ...run, masterQueue: run.workerQueue ?? "main" }], "new");

        await setTimeout(500);

        const queryRuns = clickhouse.reader.query({
          name: "runs-replication-backfill-gen",
          query:
            "SELECT run_id, _version FROM trigger_dev.task_runs_v2 WHERE run_id = {run_id:String}",
          schema: z.object({ run_id: z.string(), _version: z.number() }),
          params: z.object({ run_id: z.string() }),
        });

        const [queryError, result] = await queryRuns({ run_id: run.id });

        expect(queryError).toBeNull();
        expect(result).toHaveLength(1);

        // Decode origin generation from _version: top 8 bits = gen (>> 56).
        const versionBigInt = BigInt(result![0]!._version);
        const originGen = Number(versionBigInt >> 56n);
        expect(originGen).toBe(NEW_ORIGIN_GENERATION);
      } finally {
        await pg17.stop({ timeout: 0 });
      }
    }
  );
});

describe("RunsReplication multi-source wiring (integration)", () => {
  replicationContainerTest(
    "both sources acquire their leader locks (two-leaders proof against the double-prefixed redlock key)",
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

      const sources = buildReplicationSources({
        splitEnabled: true,
        legacyUrl,
        newUrl,
        newSourceOverride: true,
        legacySlotName: "tr_legacy_wiring",
        legacyPublicationName: "tr_legacy_wiring_pub",
        legacyOriginGeneration: 0,
        newSlotName: "tr_new_wiring",
        newPublicationName: "tr_new_wiring_pub",
        newOriginGeneration: 1,
      });

      let service: RunsReplicationService | undefined;
      let probe: Redis | undefined;

      try {
        await prisma.$executeRawUnsafe(`ALTER TABLE public."TaskRun" REPLICA IDENTITY FULL;`);

        const newPrismaForAlter = new PrismaClient({ datasources: { db: { url: newUrl } } });
        try {
          await newPrismaForAlter.$executeRawUnsafe(
            `ALTER TABLE public."TaskRun" REPLICA IDENTITY FULL;`
          );
        } finally {
          await newPrismaForAlter.$disconnect();
        }

        service = new RunsReplicationService({
          clickhouseFactory: new TestReplicationClickhouseFactory(clickhouse),
          serviceName: "runs-replication",
          pgConnectionUrl: legacyUrl,
          slotName: "tr_legacy_wiring",
          publicationName: "tr_legacy_wiring_pub",
          redisOptions: { ...redisOptions, keyPrefix: "runs-replication:" },
          sources,
          maxFlushConcurrency: 1,
          flushIntervalMs: 100,
          flushBatchSize: 1,
          leaderLockTimeoutMs: 5000,
          leaderLockExtendIntervalMs: 1000,
          ackIntervalSeconds: 5,
          tracer,
          logLevel: "warn",
        });

        await service.start();

        probe = new Redis(redisOptions);

        // Leader lock is keyed on the slot, so each source holds a distinct
        // slot-keyed lock (double-prefixed: connection keyPrefix + redlock resource).
        const legacyKey =
          "runs-replication:logical-replication-client:logical-replication-client:tr_legacy_wiring";
        const newKey =
          "runs-replication:logical-replication-client:logical-replication-client:tr_new_wiring";

        // Poll until BOTH sources have elected a leader instead of a flaky flat sleep.
        const readinessTimeoutMs = 15_000;
        const readinessPollIntervalMs = 100;
        const readinessDeadline = Date.now() + readinessTimeoutMs;

        let legacyLocked = 0;
        let newLocked = 0;

        while (Date.now() < readinessDeadline) {
          [legacyLocked, newLocked] = await Promise.all([
            probe.exists(legacyKey),
            probe.exists(newKey),
          ]);

          if (legacyLocked === 1 && newLocked === 1) {
            break;
          }

          await setTimeout(readinessPollIntervalMs);
        }

        expect(
          legacyLocked === 1 && newLocked === 1,
          `Both leader locks should be acquired within ${readinessTimeoutMs}ms ` +
            `(legacy=${legacyLocked}, new=${newLocked})`
        ).toBe(true);

        expect(await probe.exists(legacyKey)).toBe(1);
        expect(await probe.exists(newKey)).toBe(1);
      } finally {
        await service?.stop();
        await probe?.quit();
        await pg17.stop({ timeout: 0 });
      }
    }
  );
});

// Logical replication needs a session-mode connection, which a transaction pooler cannot serve.
// The app writer DSN is pooled in a real deployment, so a shard replication source must take the
// shard's DIRECT url. Getting this wrong throws inside service.start(), which is not a
// SplitReplicationMisconfiguredError, so the process stays up with every source down.
describe("shard replication uses the direct connection", () => {
  const baseArgs = {
    legacyUrl: "postgres://legacy",
    legacySlotName: "v1",
    legacyPublicationName: "v1_pub",
    legacyOriginGeneration: 0,
    newSlotName: "v2",
    newPublicationName: "v2_pub",
    newOriginGeneration: 1,
    splitEnabled: true,
    newUrl: "postgres://new",
  };
  const rep = { slotName: "sa", publicationName: "pa", originGeneration: 2 };

  it("prefers the shard's directUrl over its pooled url", () => {
    const sources = buildReplicationSources({
      ...baseArgs,
      shards: [
        {
          key: "a",
          url: "postgres://pooled:6432/shard_a",
          directUrl: "postgres://direct:5432/shard_a",
          replication: rep,
        },
      ],
    });
    const shard = sources.find((s) => s.id === "shard-a");
    expect(shard?.pgConnectionUrl).toBe("postgres://direct:5432/shard_a");
  });

  it("falls back to url when no directUrl is given", () => {
    const sources = buildReplicationSources({
      ...baseArgs,
      shards: [{ key: "a", url: "postgres://only-url/shard_a", replication: rep }],
    });
    const shard = sources.find((s) => s.id === "shard-a");
    expect(shard?.pgConnectionUrl).toBe("postgres://only-url/shard_a");
  });

  it("refuses the boot when a replicating shard declares no directUrl", () => {
    expect(() =>
      assertReplicationCoversSplit({
        splitEnabled: true,
        sources: buildReplicationSources({
          ...baseArgs,
          shards: [{ key: "a", url: "postgres://u", replication: rep }],
        }),
        shards: [{ key: "a", hasDirectUrl: false }],
      })
    ).toThrow(SplitReplicationMisconfiguredError);
  });

  it("names the shard and the reason in that failure", () => {
    expect(() =>
      assertReplicationCoversSplit({
        splitEnabled: true,
        sources: buildReplicationSources({
          ...baseArgs,
          shards: [{ key: "a", url: "postgres://u", replication: rep }],
        }),
        shards: [{ key: "a", hasDirectUrl: false }],
      })
    ).toThrow(/shard a.*directUrl|directUrl.*shard a/is);
  });

  it("does NOT refuse when the replicating shard declares a directUrl", () => {
    expect(() =>
      assertReplicationCoversSplit({
        splitEnabled: true,
        sources: buildReplicationSources({
          ...baseArgs,
          shards: [{ key: "a", url: "postgres://u", directUrl: "postgres://d", replication: rep }],
        }),
        shards: [{ key: "a", hasDirectUrl: true }],
      })
    ).not.toThrow();
  });

  it("does NOT require a directUrl for an aliased shard", () => {
    expect(() =>
      assertReplicationCoversSplit({
        splitEnabled: true,
        sources: buildReplicationSources({ ...baseArgs, shards: [] }),
        shards: [{ key: "z", aliasOf: "new", hasDirectUrl: false }],
      })
    ).not.toThrow();
  });
});
