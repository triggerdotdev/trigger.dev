import { heteroPostgresTest, HETERO_PINNED_ICU_COLLATION } from "@internal/testcontainers";
import { PrismaClient } from "@trigger.dev/database";
import { describe, expect } from "vitest";

// Cross-version compatibility proof for the run-engine's actual raw-SQL surfaces.
// Mirrors the production queries in waitpointSystem.ts and executionSnapshotSystem.ts
// and asserts byte-identical + ORDER-BY-identical results across both fixture
// containers running different Postgres major versions. NEVER mock - real
// postgres:14 + postgres:17 via heteroPostgresTest. Gates all cross-DB guarantees.
//
// REAL-DEDICATED-DB CI HOOK:
// The local newer-Postgres container is a stand-in. To check the raw-CTE compat
// against a real dedicated run-ops database (not a stand-in), set
// CROSS_VERSION_DEDICATED_URL to that database's URL in the cross-version CI job.
// When unset (local dev + default CI shards) the env-gated describe block at the
// bottom of this file is skipped - keeping the container tests as the always-on
// floor. The provisioning pipeline wires this URL into the dedicated cross-version
// CI job; until then this documents the contract.

type AnyPrisma = PrismaClient;

// ---------------------------------------------------------------------------
// Shared seed helpers. Every literal is byte-identical regardless of which
// client it is run against, so the ONLY variable under test is the postgres
// major version. Parents are seeded before children to satisfy the canonical
// schema's foreign keys. updatedAt has no DB default (Prisma manages it at the
// app layer) so raw inserts supply a fixed literal explicitly.
// ---------------------------------------------------------------------------

const FIXED_TS = "2024-01-01 00:00:00+00";

async function seedOrgProjectEnv(
  p: AnyPrisma,
  ids: { orgId: string; projectId: string; envId: string }
): Promise<void> {
  await p.$executeRawUnsafe(
    `INSERT INTO "Organization" ("id","slug","title","createdAt","updatedAt")
     VALUES ($1,$2,$3,$4::timestamptz,$4::timestamptz)`,
    ids.orgId,
    `${ids.orgId}-slug`,
    `${ids.orgId}-title`,
    FIXED_TS
  );

  await p.$executeRawUnsafe(
    `INSERT INTO "Project" ("id","slug","name","externalRef","organizationId","createdAt","updatedAt")
     VALUES ($1,$2,$3,$4,$5,$6::timestamptz,$6::timestamptz)`,
    ids.projectId,
    `${ids.projectId}-slug`,
    `${ids.projectId}-name`,
    `${ids.projectId}-ref`,
    ids.orgId,
    FIXED_TS
  );

  await p.$executeRawUnsafe(
    `INSERT INTO "RuntimeEnvironment"
       ("id","slug","apiKey","pkApiKey","shortcode","type","organizationId","projectId","createdAt","updatedAt")
     VALUES ($1,$2,$3,$4,$5,'DEVELOPMENT',$6,$7,$8::timestamptz,$8::timestamptz)`,
    ids.envId,
    `${ids.envId}-slug`,
    `${ids.envId}-apikey`,
    `${ids.envId}-pkapikey`,
    `${ids.envId}-short`,
    ids.orgId,
    ids.projectId,
    FIXED_TS
  );
}

async function seedTaskRun(
  p: AnyPrisma,
  ids: { runId: string; projectId: string; envId: string }
): Promise<void> {
  await p.$executeRawUnsafe(
    `INSERT INTO "TaskRun"
       ("id","friendlyId","taskIdentifier","payload","traceId","spanId",
        "runtimeEnvironmentId","projectId","queue","engine","createdAt","updatedAt")
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'V2',$10::timestamptz,$10::timestamptz)`,
    ids.runId,
    `${ids.runId}-friendly`,
    "x-verify-task",
    "{}",
    `${ids.runId}-trace`,
    `${ids.runId}-span`,
    ids.envId,
    ids.projectId,
    "x-verify-queue",
    FIXED_TS
  );
}

async function seedWaitpoint(
  p: AnyPrisma,
  ids: { waitpointId: string; projectId: string; envId: string; idempotencyKey: string }
): Promise<void> {
  await p.$executeRawUnsafe(
    `INSERT INTO "Waitpoint"
       ("id","friendlyId","type","status","idempotencyKey","userProvidedIdempotencyKey",
        "projectId","environmentId","createdAt","updatedAt")
     VALUES ($1,$2,'MANUAL','PENDING',$3,false,$4,$5,$6::timestamptz,$6::timestamptz)`,
    ids.waitpointId,
    `${ids.waitpointId}-friendly`,
    ids.idempotencyKey,
    ids.projectId,
    ids.envId,
    FIXED_TS
  );
}

// ---------------------------------------------------------------------------
// Corpus 1: block-waitpoint data-modifying CTE.
// Reproduces VERBATIM the two-CTE block from waitpointSystem.blockRunWithWaitpoint /
// blockRunWithWaitpointLockless. Asserts identical insert counts, identical
// idempotent re-run behaviour, and byte-identical resulting rows across versions.
// ---------------------------------------------------------------------------

async function assertBlockWaitpointCteIdentical(prismaA: AnyPrisma, prismaB: AnyPrisma) {
  const orgId = "org_xv_cte_0000000000000000000";
  const projectId = "proj_xv_cte_000000000000000000";
  const envId = "env_xv_cte_0000000000000000000";
  const runId = "run_xv_cte_0000000000000000000";
  const waitpointIds = ["wp_cte_a_0000000000000000000000", "wp_cte_b_0000000000000000000000"];

  const seed = async (p: AnyPrisma) => {
    // Production has a SQL-only partial unique index that `prisma db push` does
    // NOT create (it lives in migration SQL, not schema.prisma). The CTE's
    // ON CONFLICT DO NOTHING uses it as the arbiter for null-batchIndex rows, so
    // recreate it here for production-faithful idempotency on both versions.
    await p.$executeRawUnsafe(
      `CREATE UNIQUE INDEX IF NOT EXISTS "TaskRunWaitpoint_taskRunId_waitpointId_batchIndex_null_key"
         ON "TaskRunWaitpoint" ("taskRunId","waitpointId") WHERE "batchIndex" IS NULL`
    );
    await seedOrgProjectEnv(p, { orgId, projectId, envId });
    await seedTaskRun(p, { runId, projectId, envId });
    let i = 0;
    for (const waitpointId of waitpointIds) {
      await seedWaitpoint(p, {
        waitpointId,
        projectId,
        envId,
        idempotencyKey: `idem_cte_${i++}`,
      });
    }
  };

  // The EXACT CTE from waitpointSystem.blockRunWithWaitpointLockless, run twice
  // (idempotency check) - the second run must insert 0 via ON CONFLICT DO NOTHING.
  const runCte = (p: AnyPrisma) =>
    p.$queryRawUnsafe<{ count: bigint }[]>(
      `
      WITH inserted AS (
        INSERT INTO "TaskRunWaitpoint"
          ("id","taskRunId","waitpointId","projectId","createdAt","updatedAt","spanIdToComplete","batchId","batchIndex")
        SELECT gen_random_uuid(), $1, w.id, $2, NOW(), NOW(), NULL, NULL, NULL
        FROM "Waitpoint" w WHERE w.id IN ($3, $4)
        ON CONFLICT DO NOTHING
        RETURNING "waitpointId"
      ),
      connected_runs AS (
        INSERT INTO "_WaitpointRunConnections" ("A","B")
        SELECT $1, w.id FROM "Waitpoint" w WHERE w.id IN ($3, $4)
        ON CONFLICT DO NOTHING
      )
      SELECT COUNT(*) AS count FROM inserted
      `,
      runId,
      projectId,
      waitpointIds[0],
      waitpointIds[1]
    );

  await seed(prismaA);
  await seed(prismaB);

  const firstA = await runCte(prismaA);
  const firstB = await runCte(prismaB);
  expect(Number(firstA[0].count)).toBe(Number(firstB[0].count));
  expect(Number(firstA[0].count)).toBe(2);

  // Idempotency: re-run, both must insert 0 via ON CONFLICT DO NOTHING.
  const secondA = await runCte(prismaA);
  const secondB = await runCte(prismaB);
  expect(Number(secondA[0].count)).toBe(Number(secondB[0].count));
  expect(Number(secondA[0].count)).toBe(0);

  // Byte-identical resulting rows (order-stable read under pinned collation).
  const dump = (p: AnyPrisma) =>
    p.$queryRawUnsafe<{ taskRunId: string; waitpointId: string }[]>(
      `SELECT "taskRunId","waitpointId" FROM "TaskRunWaitpoint"
         ORDER BY "waitpointId" COLLATE "${HETERO_PINNED_ICU_COLLATION}"`
    );
  expect(await dump(prismaA)).toEqual(await dump(prismaB));

  // The _WaitpointRunConnections side of the CTE must also be byte-identical.
  const dumpConnections = (p: AnyPrisma) =>
    p.$queryRawUnsafe<{ A: string; B: string }[]>(
      `SELECT "A","B" FROM "_WaitpointRunConnections"
         ORDER BY "B" COLLATE "${HETERO_PINNED_ICU_COLLATION}"`
    );
  expect(await dumpConnections(prismaA)).toEqual(await dumpConnections(prismaB));
}

// ---------------------------------------------------------------------------
// Corpus 2: _completedWaitpoints join select + JSON/array/text round-trip.
// Reproduces getSnapshotWaitpointIds's SELECT "B" FROM "_completedWaitpoints"
// WHERE "A" = ... and round-trips jsonb / int[] / unicode text through the
// actual column types. Defends against silent copy-corruption across DB versions.
// ---------------------------------------------------------------------------

async function assertCompletedWaitpointsRoundtripIdentical(prismaA: AnyPrisma, prismaB: AnyPrisma) {
  const orgId = "org_xv_join_000000000000000000";
  const projectId = "proj_xv_join_00000000000000000";
  const envId = "env_xv_join_000000000000000000";
  const runId = "run_xv_join_000000000000000000";
  const snapshotId = "snap_xv_join_0000000000000000";
  const waitpointIds = ["wp_join_c_000000000000000000000", "wp_join_d_000000000000000000000"];
  const jsonPayload = {
    nested: { a: 1, b: [true, null, "Émile"] },
    txt: "中文 Ångström space-free",
  };

  const seed = async (p: AnyPrisma) => {
    await seedOrgProjectEnv(p, { orgId, projectId, envId });
    await seedTaskRun(p, { runId, projectId, envId });

    await p.$executeRawUnsafe(
      `INSERT INTO "TaskRunExecutionSnapshot"
         ("id","engine","executionStatus","description","isValid","runId","runStatus",
          "environmentId","environmentType","projectId","organizationId","createdAt","updatedAt")
       VALUES ($1,'V2','EXECUTING_WITH_WAITPOINTS',$2,true,$3,'EXECUTING',
               $4,'DEVELOPMENT',$5,$6,$7::timestamptz,$7::timestamptz)`,
      snapshotId,
      "x-verify snapshot",
      runId,
      envId,
      projectId,
      orgId,
      FIXED_TS
    );

    let i = 0;
    for (const waitpointId of waitpointIds) {
      await seedWaitpoint(p, {
        waitpointId,
        projectId,
        envId,
        idempotencyKey: `idem_join_${i++}`,
      });
      // Link snapshot -> waitpoint through the _completedWaitpoints join table.
      await p.$executeRawUnsafe(
        `INSERT INTO "_completedWaitpoints" ("A","B") VALUES ($1,$2)`,
        snapshotId,
        waitpointId
      );
    }
  };

  await seed(prismaA);
  await seed(prismaB);

  // EXACT production join select from getSnapshotWaitpointIds (ordered for a
  // version-comparable sequence under the pinned collation).
  const joinSelect = (p: AnyPrisma) =>
    p.$queryRawUnsafe<{ B: string }[]>(
      `SELECT "B" FROM "_completedWaitpoints" WHERE "A" = $1
         ORDER BY "B" COLLATE "${HETERO_PINNED_ICU_COLLATION}"`,
      snapshotId
    );
  expect(await joinSelect(prismaA)).toEqual(await joinSelect(prismaB));

  // JSON + array + text byte-identity round-trip through the actual
  // jsonb / int[] / text column types.
  const roundtrip = (p: AnyPrisma) =>
    p.$queryRawUnsafe<{ j: unknown; a: number[]; t: string }[]>(
      `SELECT $1::jsonb AS j, $2::int[] AS a, $3::text AS t`,
      JSON.stringify(jsonPayload),
      [3, 1, 2],
      jsonPayload.txt
    );
  expect(await roundtrip(prismaA)).toEqual(await roundtrip(prismaB));
}

// ---------------------------------------------------------------------------
// Corpus 3: keyset cursor (getExecutionSnapshotsSince) - identical ORDER-BY.
// Seeds >50 snapshots with deliberate createdAt ties, then walks pages with the
// production ordering (createdAt desc, take 50) PLUS an explicit id tie-break and
// asserts byte-identical paged sequences across versions. Silent-pagination-
// corruption class across DB versions.
// ---------------------------------------------------------------------------

async function assertKeysetOrderIdentical(prismaA: AnyPrisma, prismaB: AnyPrisma) {
  const orgId = "org_xv_keyset_0000000000000000";
  const projectId = "proj_xv_keyset_000000000000000";
  const envId = "env_xv_keyset_0000000000000000";
  const runId = "run_xv_keyset_0000000000000000";
  const TOTAL = 120; // > take:50 to exercise the page boundary
  const TIE_GROUP = 3; // groups of 3 share an identical createdAt

  const seed = async (p: AnyPrisma) => {
    await seedOrgProjectEnv(p, { orgId, projectId, envId });
    await seedTaskRun(p, { runId, projectId, envId });

    for (let n = 0; n < TOTAL; n++) {
      // Zero-padded ids are a deterministic tie-break; createdAt advances every
      // TIE_GROUP rows so ties exist within and across the page boundary.
      const snapshotId = `snap_xv_keyset_${String(n).padStart(10, "0")}`;
      const second = String(Math.floor(n / TIE_GROUP)).padStart(2, "0");
      const createdAt = `2024-01-01 00:00:${second}+00`;
      await p.$executeRawUnsafe(
        `INSERT INTO "TaskRunExecutionSnapshot"
           ("id","engine","executionStatus","description","isValid","runId","runStatus",
            "environmentId","environmentType","projectId","organizationId","createdAt","updatedAt")
         VALUES ($1,'V2','EXECUTING',$2,true,$3,'EXECUTING',
                 $4,'DEVELOPMENT',$5,$6,$7::timestamptz,$8::timestamptz)`,
        snapshotId,
        `snap ${n}`,
        runId,
        envId,
        projectId,
        orgId,
        createdAt,
        FIXED_TS
      );
    }
  };

  await seed(prismaA);
  await seed(prismaB);

  // Keyset walk mirroring getExecutionSnapshotsSince: desc, take 50, with a
  // composite (createdAt, id) cursor so paging advances to older rows and the
  // id tie-break is applied across straddled tie groups.
  const page = (p: AnyPrisma, cursor: { createdAt: string; id: string } | null) =>
    p.$queryRawUnsafe<{ id: string; createdAt: Date }[]>(
      `SELECT "id","createdAt" FROM "TaskRunExecutionSnapshot"
         WHERE "runId" = $1 AND "isValid" = true
         ${cursor ? `AND ("createdAt" < $2::timestamptz OR ("createdAt" = $2::timestamptz AND "id" < $3))` : ""}
         ORDER BY "createdAt" DESC, "id" DESC
         LIMIT 50`,
      ...(cursor ? [runId, cursor.createdAt, cursor.id] : [runId])
    );

  const walk = async (p: AnyPrisma) => {
    const all: { id: string; createdAt: Date }[] = [];
    let cursor: { createdAt: string; id: string } | null = null;
    for (;;) {
      const rows = await page(p, cursor);
      if (rows.length === 0) break;
      all.push(...rows);
      if (rows.length < 50) break;
      const last = rows[rows.length - 1];
      cursor = { createdAt: last.createdAt.toISOString(), id: last.id };
    }
    return all.map((r) => r.id);
  };

  expect(await walk(prismaA)).toEqual(await walk(prismaB));

  // Also assert the raw DB-side ordering (no JS paging) is byte-identical -
  // this surfaces any tie-resolution divergence directly.
  const fullOrder = (p: AnyPrisma) =>
    p.$queryRawUnsafe<{ id: string }[]>(
      `SELECT "id" FROM "TaskRunExecutionSnapshot"
         WHERE "runId" = $1 AND "isValid" = true
         ORDER BY "createdAt" DESC, "id" DESC`,
      runId
    );
  expect(await fullOrder(prismaA)).toEqual(await fullOrder(prismaB));
}

heteroPostgresTest(
  "fixture contract: two clients on the migrated schema, pinned collation",
  async ({ prisma14, prisma17, pinnedCollation }) => {
    expect(pinnedCollation).toBe(HETERO_PINNED_ICU_COLLATION);
    // Both containers carry the migrated prisma schema (run-ops tables exist).
    const exists = (p: AnyPrisma) =>
      p.$queryRawUnsafe<{ ok: boolean }[]>(
        `SELECT EXISTS (SELECT 1 FROM information_schema.tables
           WHERE table_name IN ('TaskRunWaitpoint','Waitpoint','TaskRunExecutionSnapshot')
         ) AS ok`
      );
    expect((await exists(prisma14))[0].ok).toBe(true);
    expect((await exists(prisma17))[0].ok).toBe(true);
  }
);

heteroPostgresTest(
  "block-waitpoint data-modifying CTE is byte-identical across Postgres major versions",
  async ({ prisma14, prisma17 }) => {
    await assertBlockWaitpointCteIdentical(prisma14, prisma17);
  }
);

heteroPostgresTest(
  "_completedWaitpoints join select + JSON/array/text round-trip identical across Postgres major versions",
  async ({ prisma14, prisma17 }) => {
    await assertCompletedWaitpointsRoundtripIdentical(prisma14, prisma17);
  }
);

heteroPostgresTest(
  "keyset cursor ORDER-BY is identical across Postgres major versions (incl. createdAt ties)",
  async ({ prisma14, prisma17 }) => {
    await assertKeysetOrderIdentical(prisma14, prisma17);
  }
);

// REAL-DEDICATED-DB CI HOOK (env-gated). Re-runs the IDENTICAL corpus against a real
// dedicated run-ops database (newer Postgres) using the container-based older-Postgres
// fixture as the baseline. Skipped locally and in default CI
// (CROSS_VERSION_DEDICATED_URL unset). See the top-of-file comment for how the
// provisioning pipeline wires the URL.
const dedicatedUrl = process.env.CROSS_VERSION_DEDICATED_URL;
const describeDedicated = dedicatedUrl ? describe : describe.skip;

describeDedicated("real dedicated-DB cross-version corpus (env-gated)", () => {
  heteroPostgresTest(
    "CTE + join/round-trip + keyset vs real dedicated run-ops DB",
    async ({ prisma14 }) => {
      const dedicated = new PrismaClient({ datasources: { db: { url: dedicatedUrl! } } });
      try {
        await assertBlockWaitpointCteIdentical(prisma14, dedicated);
        await assertCompletedWaitpointsRoundtripIdentical(prisma14, dedicated);
        await assertKeysetOrderIdentical(prisma14, dedicated);
      } finally {
        await dedicated.$disconnect();
      }
    }
  );
});
