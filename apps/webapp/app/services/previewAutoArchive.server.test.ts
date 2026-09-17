import { postgresTest } from "@internal/testcontainers";
import { expect, test } from "vitest";
import type { PrismaClient } from "@trigger.dev/database";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { $transaction } from "~/db.server";
import { FeatureFlagCatalog, FEATURE_FLAG } from "~/v3/featureFlags";
import { createDeploymentWithNextVersion } from "~/v3/services/initializeDeployment/createDeploymentWithNextVersion.server";
import {
  PreviewAutoArchivePolicy,
  PREVIEW_AUTO_ARCHIVE_DAY_MS as DAY,
} from "~/utils/previewAutoArchive";
import {
  seedPreviewArchive as seed,
  archiveTestNow as now,
  archiveTestOld as old,
} from "../../test/fixtures/previewAutoArchive";
import {
  processPreviewAutoArchivePage,
  previewAutoArchiveCount,
  savePreviewAutoArchivePolicy,
  isPreviewAutoArchiveEnabled,
  previewBranchActivity,
} from "./previewAutoArchive.server";

postgresTest(
  "rollout defaults off with organization overrides over the global flag",
  async ({ prisma }) => {
    const key = FEATURE_FLAG.previewAutoArchiveEnabled;
    expect(FeatureFlagCatalog[key].safeParse("false").success).toBe(false);
    expect(await isPreviewAutoArchiveEnabled(prisma, null)).toBe(false);
    expect(await isPreviewAutoArchiveEnabled(prisma, { [key]: true })).toBe(true);
    await prisma.featureFlag.create({ data: { key, value: true } });
    expect(await isPreviewAutoArchiveEnabled(prisma, null)).toBe(true);
    expect(await isPreviewAutoArchiveEnabled(prisma, { [key]: false })).toBe(false);
    await prisma.featureFlag.update({ where: { key }, data: { value: false } });
    expect(await isPreviewAutoArchiveEnabled(prisma, null)).toBe(false);
    expect(await isPreviewAutoArchiveEnabled(prisma, { [key]: true })).toBe(true);
  }
);

postgresTest(
  "disabled rollout preserves configured policies and resumes when globally enabled",
  async ({ prisma }) => {
    const { parent, branch } = await seed(prisma, false);
    const candidate = await branch();
    const page = await processPreviewAutoArchivePage(prisma, 0, now);
    expect(page).toMatchObject({ scanned: 0, archived: [] });
    const paused = await prisma.runtimeEnvironment.findFirstOrThrow({ where: { id: parent.id } });
    expect(paused.previewAutoArchiveAfterDays).toBe(14);
    expect(paused.previewAutoArchiveNextCheckAt).toEqual(new Date(now.getTime() + 3_600_000));
    await prisma.featureFlag.create({
      data: { key: FEATURE_FLAG.previewAutoArchiveEnabled, value: true },
    });
    const resumed = await processPreviewAutoArchivePage(
      prisma,
      0,
      paused.previewAutoArchiveNextCheckAt!
    );
    expect(resumed?.archived.map(({ id }) => id)).toEqual([candidate.id]);
  }
);

postgresTest(
  "revoking rollout between pages pauses without losing the cursor",
  async ({ prisma }) => {
    const { parent, organization, branch } = await seed(prisma);
    for (let i = 0; i < 101; i++) await branch();
    expect((await processPreviewAutoArchivePage(prisma, 0, now))?.archived).toHaveLength(100);
    const before = await prisma.runtimeEnvironment.findFirstOrThrow({ where: { id: parent.id } });
    await prisma.organization.update({
      where: { id: organization.id },
      data: { featureFlags: { previewAutoArchiveEnabled: false } },
    });
    await prisma.featureFlag.create({
      data: { key: FEATURE_FLAG.previewAutoArchiveEnabled, value: true },
    });
    expect(await processPreviewAutoArchivePage(prisma, 0, now)).toMatchObject({
      scanned: 0,
      archived: [],
    });
    const paused = await prisma.runtimeEnvironment.findFirstOrThrow({ where: { id: parent.id } });
    expect(paused.previewAutoArchiveCursorId).toBe(before.previewAutoArchiveCursorId);
    expect(paused.previewAutoArchiveCursorCreatedAt).toEqual(
      before.previewAutoArchiveCursorCreatedAt
    );
    await prisma.organization.update({
      where: { id: organization.id },
      data: { featureFlags: {} },
    });
    expect(
      (await processPreviewAutoArchivePage(prisma, 0, paused.previewAutoArchiveNextCheckAt!))
        ?.archived
    ).toHaveLength(1);
  }
);

const archiveGuard = {
  archiveGuard: {
    type: "PREVIEW" as const,
  },
};

postgresTest(
  "branch activity uses latest deployment and bounded existence probes",
  async ({ prisma }) => {
    const { branch, deployment } = await seed(prisma);
    const empty = await branch();
    const active = await branch();
    await deployment(active.id, old, "BUILDING");
    await deployment(active.id, now, "FAILED");
    const rows = await previewBranchActivity(prisma, [empty.id, active.id]);
    expect(rows.get(empty.id)).toMatchObject({ lastDeploymentAt: null, inProgress: false });
    expect(rows.get(active.id)).toMatchObject({ lastDeploymentAt: now, inProgress: true });
    await expect(previewBranchActivity(prisma, Array(1001).fill(empty.id))).rejects.toThrow(
      "exceeds 1000"
    );
  }
);

function barrier() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

postgresTest(
  "live preview separates ready, future, protected and in-progress branches",
  async ({ prisma }) => {
    const { parent, branch, deployment } = await seed(prisma);
    await branch("ready");
    await branch("new", now);
    await branch("protected-old");
    await branch("protected-new", now);
    const recent = await branch("recent");
    await deployment(recent.id, now, "FAILED");
    const active = await branch("active");
    await deployment(active.id, now, "BUILDING");
    const archived = await branch("archived");
    await prisma.runtimeEnvironment.update({
      where: { id: archived.id },
      data: { archivedAt: now },
    });
    const other = await seed(prisma);
    await other.branch("other-project");
    const preview = await previewAutoArchiveCount(
      prisma,
      parent.id,
      14,
      ["protected-old", "protected-new", "missing"],
      now
    );
    expect({ ...preview, protectedBranches: preview.protectedBranches.sort() }).toEqual({
      count: 1,
      scheduled: 2,
      inProgress: 1,
      protectedBranches: ["protected-new", "protected-old"],
      partial: false,
    });
    expect(await previewAutoArchiveCount(prisma, parent.id, 30, [], now)).toMatchObject({
      count: 0,
      scheduled: 5,
      inProgress: 1,
      protectedBranches: [],
    });
  }
);

test("validates whole-day policies and exact protected names", () => {
  expect(
    PreviewAutoArchivePolicy.parse({ days: null, excludedBranches: ["staging", "staging"] })
      .excludedBranches
  ).toEqual(["staging"]);
  for (const days of [0, -1, 1.5, 366])
    expect(PreviewAutoArchivePolicy.safeParse({ days, excludedBranches: [] }).success).toBe(false);
  expect(
    PreviewAutoArchivePolicy.safeParse({ days: 14, excludedBranches: ["feature/*"] }).success
  ).toBe(false);
});

postgresTest(
  "shared eligibility agrees with preview counts and keeps recent, protected and in-flight branches",
  async ({ prisma }) => {
    const { parent, branch, deployment } = await seed(prisma);
    const cutoff = new Date(now.getTime() - 14 * DAY);
    const never = await branch();
    const boundary = await branch(undefined, cutoff);
    await branch(undefined, new Date(cutoff.getTime() + 1));
    await branch("staging");
    const recentFailure = await branch();
    await deployment(recentFailure.id, new Date(now.getTime() - DAY), "FAILED");
    const oldFailure = await branch();
    await deployment(oldFailure.id, old, "FAILED");
    const redeployed = await branch();
    await deployment(redeployed.id, old);
    await deployment(redeployed.id, new Date(now.getTime() - DAY));
    for (const status of ["PENDING", "INSTALLING", "BUILDING", "DEPLOYING"] as const) {
      const active = await branch();
      await deployment(active.id, old, status);
    }
    expect(await previewAutoArchiveCount(prisma, parent.id, 14, ["staging"], now)).toMatchObject({
      count: 3,
      partial: false,
    });
    const page = await processPreviewAutoArchivePage(prisma, 0, now);
    expect(page?.archived.map(({ id }) => id).sort()).toEqual(
      [never.id, boundary.id, oldFailure.id].sort()
    );
    expect(await processPreviewAutoArchivePage(prisma, 0, now)).toBeNull();
    expect(await previewAutoArchiveCount(prisma, parent.id, 14, ["staging"], now)).toMatchObject({
      count: 0,
      partial: false,
    });
  }
);

postgresTest("disabled policies and other environment types are excluded", async ({ prisma }) => {
  const { parent, branch } = await seed(prisma);
  const candidate = await branch();
  await savePreviewAutoArchivePolicy(prisma, parent.id, { days: null, excludedBranches: [] }, now);
  expect(await processPreviewAutoArchivePage(prisma, 0, now)).toBeNull();
  for (const type of ["DEVELOPMENT", "STAGING", "PRODUCTION"] as const) {
    await savePreviewAutoArchivePolicy(prisma, parent.id, { days: 14, excludedBranches: [] }, now);
    await prisma.runtimeEnvironment.update({ where: { id: candidate.id }, data: { type } });
    expect((await processPreviewAutoArchivePage(prisma, 0, now))?.archived).toEqual([]);
  }
});

postgresTest(
  "duplicate workers preserve history and cannot revisit a replacement generation",
  async ({ prisma }) => {
    const { branch, deployment } = await seed(prisma);
    const original = await branch("exploration");
    const history = await deployment(original.id, old);
    const results = await Promise.all(
      [0, 1, 2, 3].map((lane) => processPreviewAutoArchivePage(prisma, lane, now))
    );
    expect(results.flatMap((result) => result?.archived ?? [])).toHaveLength(1);
    const replacement = await branch("exploration", now);
    expect(replacement.id).not.toBe(original.id);
    expect(await processPreviewAutoArchivePage(prisma, 0, now)).toBeNull();
    expect(
      (await prisma.runtimeEnvironment.findFirstOrThrow({ where: { id: replacement.id } }))
        .archivedAt
    ).toBeNull();
    expect(
      await prisma.workerDeployment.count({ where: { id: history.id, environmentId: original.id } })
    ).toBe(1);
  }
);

postgresTest(
  "deployment locks are skipped without waiting, and the next sweep sees the deployment",
  async ({ prisma }) => {
    const { branch, deployData } = await seed(prisma);
    const candidate = await branch();
    const inserted = barrier();
    const commit = barrier();
    const deploying = $transaction(
      prisma,
      "testDeploymentFirst",
      async (tx) => {
        await createDeploymentWithNextVersion(tx, candidate.id, deployData, archiveGuard);
        inserted.release();
        await commit.promise;
      },
      { timeout: 15_000 }
    );
    await inserted.promise;
    try {
      expect((await processPreviewAutoArchivePage(prisma, 0, now))?.archived).toEqual([]);
    } finally {
      commit.release();
    }
    await deploying;
    expect(
      (await processPreviewAutoArchivePage(prisma, 0, new Date(now.getTime() + 60 * 60 * 1000)))
        ?.archived
    ).toEqual([]);
    expect(
      (await prisma.runtimeEnvironment.findFirstOrThrow({ where: { id: candidate.id } })).archivedAt
    ).toBeNull();
  }
);

postgresTest(
  "a deployment committed after page selection is seen by the activity read after locking",
  async ({ prisma }) => {
    const { branch, deployData } = await seed(prisma);
    const candidate = await branch();
    const scanned = barrier();
    const resume = barrier();
    let gated = false;
    // Pause a real query after it returns candidates; no database calls are mocked.
    const coordinated = prisma.$extends({
      query: {
        $queryRaw: async ({ args, query }) => {
          const result = await query(args);
          if (
            !gated &&
            Array.isArray(result) &&
            result.some(
              (row) =>
                row !== null && typeof row === "object" && "id" in row && row.id === candidate.id
            )
          ) {
            gated = true;
            scanned.release();
            await resume.promise;
          }
          return result;
        },
      },
    });
    const cleaning = processPreviewAutoArchivePage(coordinated as unknown as PrismaClient, 0, now);
    await scanned.promise;
    try {
      await createDeploymentWithNextVersion(
        prisma,
        candidate.id,
        () => ({
          ...deployData(),
          status: "FAILED",
          createdAt: now,
        }),
        archiveGuard
      );
    } finally {
      resume.release();
    }
    expect((await cleaning)?.archived).toEqual([]);
    expect(
      (await prisma.runtimeEnvironment.findFirstOrThrow({ where: { id: candidate.id } })).archivedAt
    ).toBeNull();
  }
);

postgresTest(
  "archive-first rejects a deployment prepared against the old generation",
  async ({ prisma }) => {
    const { branch, deployData } = await seed(prisma);
    const candidate = await branch();
    const preparing = barrier();
    const prepared = barrier();
    const deploying = createDeploymentWithNextVersion(
      prisma,
      candidate.id,
      async () => {
        preparing.release();
        await prepared.promise;
        return deployData();
      },
      archiveGuard
    );
    const rejected = expect(deploying).rejects.toMatchObject({
      name: "ServiceValidationError",
      status: 409,
    });
    await preparing.promise;
    try {
      expect((await processPreviewAutoArchivePage(prisma, 0, now))?.archived).toHaveLength(1);
    } finally {
      prepared.release();
    }
    await rejected;
    expect(await prisma.workerDeployment.count({ where: { environmentId: candidate.id } })).toBe(0);
  }
);

postgresTest(
  "flag enabled during deployment preparation cannot bypass the archive lock",
  async ({ prisma }) => {
    const { branch, deployData, project } = await seed(prisma, false);
    await prisma.organization.update({
      where: { id: project.organizationId },
      data: { featureFlags: { previewAutoArchiveEnabled: false } },
    });
    const candidate = await branch();
    const preparing = barrier();
    const resume = barrier();
    const deploying = createDeploymentWithNextVersion(
      prisma,
      candidate.id,
      async () => {
        preparing.release();
        await resume.promise;
        return deployData();
      },
      archiveGuard
    );
    const rejected = expect(deploying).rejects.toMatchObject({ status: 409 });
    await preparing.promise;
    try {
      await prisma.organization.update({
        where: { id: project.organizationId },
        data: { featureFlags: { previewAutoArchiveEnabled: true } },
      });
      expect((await processPreviewAutoArchivePage(prisma, 0, now))?.archived).toHaveLength(1);
    } finally {
      resume.release();
    }
    await rejected;
    expect(await prisma.workerDeployment.count({ where: { environmentId: candidate.id } })).toBe(0);
  }
);

postgresTest(
  "a policy update owns the root and prevents cleanup using an outdated policy",
  async ({ prisma }) => {
    const { parent, branch } = await seed(prisma);
    await branch();
    const changed = barrier();
    const commit = barrier();
    const saving = $transaction(
      prisma,
      "testPolicyFirst",
      async (tx) => {
        await tx.runtimeEnvironment.update({
          where: { id: parent.id },
          data: { previewAutoArchiveAfterDays: null, previewAutoArchiveNextCheckAt: null },
        });
        changed.release();
        await commit.promise;
      },
      { timeout: 15_000 }
    );
    await changed.promise;
    try {
      expect(await processPreviewAutoArchivePage(prisma, 0, now)).toBeNull();
    } finally {
      commit.release();
    }
    await saving;
    expect(await processPreviewAutoArchivePage(prisma, 0, now)).toBeNull();
  }
);

postgresTest(
  "transaction-scoped lanes bound work across duplicate worker instances",
  async ({ prisma }) => {
    await seed(prisma);
    const held = barrier();
    const release = barrier();
    const owner = $transaction(
      prisma,
      "holdArchiveLane",
      async (tx) => {
        // Prisma has no advisory-lock API. Hold the real production lane in this
        // transaction so the test exercises contention between database connections.
        await tx.$queryRaw`SELECT true AS held FROM (SELECT pg_advisory_xact_lock(hashtext('preview-branch-auto-archive'), 0)) AS lock`;
        held.release();
        await release.promise;
      },
      { timeout: 15_000 }
    );
    await held.promise;
    try {
      expect(await processPreviewAutoArchivePage(prisma, 0, now)).toBeNull();
    } finally {
      release.release();
    }
    await owner;
    expect(await processPreviewAutoArchivePage(prisma, 0, now)).not.toBeNull();
  }
);

postgresTest(
  "bounded pages advance over sparse candidates and resume after completed work disappears",
  async ({ prisma }) => {
    const { parent, branch, deployment } = await seed(prisma);
    const ids: string[] = [];
    for (let i = 0; i < 205; i++) {
      const b = await branch();
      ids.push(b.id);
      if (i < 200) await deployment(b.id, now, "FAILED");
    }
    const first = await processPreviewAutoArchivePage(prisma, 0, now);
    expect(first?.scanned).toBe(100);
    expect(first?.archived).toHaveLength(0);
    const second = await processPreviewAutoArchivePage(prisma, 0, now);
    expect(second?.scanned).toBe(100);
    expect(second?.archived).toHaveLength(0);
    const third = await processPreviewAutoArchivePage(prisma, 0, now);
    expect(third?.scanned).toBe(5);
    expect(third?.archived).toHaveLength(5);
    const saved = await prisma.runtimeEnvironment.findFirstOrThrow({ where: { id: parent.id } });
    expect(saved.previewAutoArchiveCursorId).toBeNull();
    expect(saved.previewAutoArchiveNextCheckAt).toEqual(new Date(now.getTime() + 60 * 60 * 1000));
    // A policy change must reset progress, so earlier branches are considered again.
    await savePreviewAutoArchivePolicy(prisma, parent.id, { days: 1, excludedBranches: [] }, now);
    expect(
      (await prisma.runtimeEnvironment.findFirstOrThrow({ where: { id: parent.id } }))
        .previewAutoArchiveCursorId
    ).toBeNull();
  }
);

postgresTest(
  "a failed progress commit rolls back archives, backs off and lets other projects proceed",
  async ({ prisma }) => {
    const first = await seed(prisma);
    await first.branch("rollback-target");
    const other = await seed(prisma);
    await other.branch("healthy-target");
    // Prisma has no function DDL API. Embed this test-owned ID in a trigger function
    // to fail the real progress write and verify rollback of the preceding archives.
    await prisma.$executeRawUnsafe(`CREATE FUNCTION reject_archive_progress() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF OLD.id = '${first.parent.id}' AND NEW."previewAutoArchiveNextCheckAt" = TIMESTAMP '2026-09-16 13:00:00'
    THEN RAISE EXCEPTION 'simulated crash before progress commit'; END IF; RETURN NEW; END $$`);
    // Trigger DDL is unavailable through Prisma models; attach the injected failure
    // to the actual UPDATE instead of mocking a database result.
    await prisma.$executeRawUnsafe(
      'CREATE TRIGGER archive_progress_failure BEFORE UPDATE ON "RuntimeEnvironment" FOR EACH ROW EXECUTE FUNCTION reject_archive_progress()'
    );
    await expect(processPreviewAutoArchivePage(prisma, 0, now)).rejects.toThrow("simulated crash");
    expect(
      await prisma.runtimeEnvironment.count({
        where: { parentEnvironmentId: first.parent.id, archivedAt: { not: null } },
      })
    ).toBe(0);
    const backedOff = await prisma.runtimeEnvironment.findFirstOrThrow({
      where: { id: first.parent.id },
    });
    expect(backedOff.previewAutoArchiveCursorId).toBeNull();
    expect(backedOff.previewAutoArchiveNextCheckAt).toEqual(
      new Date(now.getTime() + 5 * 60 * 1000)
    );
    expect((await processPreviewAutoArchivePage(prisma, 0, now))?.parentId).toBe(other.parent.id);
    // Remove the test trigger through DDL so the retry can exercise a successful commit.
    await prisma.$executeRawUnsafe('DROP TRIGGER archive_progress_failure ON "RuntimeEnvironment"');
    expect(
      (await processPreviewAutoArchivePage(prisma, 0, new Date(now.getTime() + 5 * 60 * 1000)))
        ?.archived
    ).toHaveLength(1);
  }
);

postgresTest(
  "a large project yields between pages and deleted tenants stop scheduling",
  async ({ prisma }) => {
    const first = await seed(prisma);
    for (let i = 0; i < 101; i++) await first.branch();
    const second = await seed(prisma);
    await prisma.runtimeEnvironment.update({
      where: { id: first.parent.id },
      data: { previewAutoArchiveNextCheckAt: old },
    });
    expect((await processPreviewAutoArchivePage(prisma, 0, now))?.parentId).toBe(first.parent.id);
    // The first page moves to the back of the due queue.
    await prisma.runtimeEnvironment.update({
      where: { id: second.parent.id },
      data: { previewAutoArchiveNextCheckAt: new Date(now.getTime() - 1) },
    });
    await prisma.organization.update({
      where: { id: second.organization.id },
      data: { deletedAt: now },
    });
    expect((await processPreviewAutoArchivePage(prisma, 0, now))?.parentId).toBe(second.parent.id);
    expect(
      (await prisma.runtimeEnvironment.findFirstOrThrow({ where: { id: second.parent.id } }))
        .previewAutoArchiveNextCheckAt
    ).toBeNull();
    const last = await processPreviewAutoArchivePage(prisma, 0, now);
    expect(last?.parentId).toBe(first.parent.id);
    expect(last?.archived).toHaveLength(1);
    expect(last?.complete).toBe(true);
  }
);

postgresTest("preview counts are bounded and disclose incomplete results", async ({ prisma }) => {
  const { parent, project, organization } = await seed(prisma);
  // Test fixture only: generate_series creates the deterministic overflow sample in
  // one INSERT. This is fixture convenience, not a requirement of the production query.
  await prisma.$executeRaw`
    INSERT INTO "RuntimeEnvironment" (id, slug, shortcode, "apiKey", "pkApiKey", "projectId", "organizationId", type, "branchName", "parentEnvironmentId", "createdAt", "updatedAt")
    SELECT 'count-' || i, 'count-' || i, 'count-' || i, 'api-' || i, 'pk-' || i, ${project.id}, ${organization.id}, 'PREVIEW', 'branch-' || i, ${parent.id}, ${old}, ${old}
    FROM generate_series(1, 1002) AS i
  `;
  expect(await previewAutoArchiveCount(prisma, parent.id, 14, [], now)).toMatchObject({
    count: 1000,
    partial: true,
  });
});

postgresTest(
  "additive migrations preserve branches and create usable indexes",
  async ({ prisma, postgresContainer }) => {
    const { parent, branch } = await seed(prisma);
    const existing = await branch();
    // Prisma cannot remove columns through its model API. Recreate the pre-migration
    // table shape in this isolated test database before running the real migrations.
    await prisma.$executeRawUnsafe(
      'ALTER TABLE "RuntimeEnvironment" DROP COLUMN "previewAutoArchiveAfterDays", DROP COLUMN "previewAutoArchiveExcludedBranches", DROP COLUMN "previewAutoArchiveNextCheckAt", DROP COLUMN "previewAutoArchiveCursorCreatedAt", DROP COLUMN "previewAutoArchiveCursorId"'
    );
    const migrations = [
      "20260916120000_preview_auto_archive",
      "20260916130001_preview_archive_due_index",
      "20260916130002_preview_archive_branch_index",
    ];
    const directory = await mkdtemp(join(tmpdir(), "preview-archive-migrations-"));
    const database = fileURLToPath(
      new URL("../../../../internal-packages/database/", import.meta.url)
    );
    const schema = join(directory, "schema.prisma");
    const env = {
      ...process.env,
      DATABASE_URL: postgresContainer.getConnectionUri(),
      DIRECT_URL: postgresContainer.getConnectionUri(),
    };
    const exec = promisify(execFile);
    try {
      await copyFile(join(database, "prisma/schema.prisma"), schema);
      await mkdir(join(directory, "migrations/000_baseline"), { recursive: true });
      await writeFile(
        join(directory, "migrations/000_baseline/migration.sql"),
        "-- db push baseline\n"
      );
      await writeFile(
        join(directory, "migrations/migration_lock.toml"),
        'provider = "postgresql"\n'
      );
      for (const migration of migrations.slice(0, 1)) {
        await mkdir(join(directory, "migrations", migration));
        await copyFile(
          join(database, "prisma/migrations", migration, "migration.sql"),
          join(directory, "migrations", migration, "migration.sql")
        );
      }
      // Exercise the real Prisma runner: splitting SQL statements masks concurrent-index failures.
      await exec(
        "pnpm",
        ["exec", "prisma", "migrate", "resolve", "--applied", "000_baseline", "--schema", schema],
        { cwd: database, env }
      );
      await exec("pnpm", ["exec", "prisma", "migrate", "deploy", "--schema", schema], {
        cwd: database,
        env,
      });
      // Operations may pre-create indexes between the schema rollout and index migrations.
      const dueSql = await readFile(
        join(database, "prisma/migrations", migrations[1], "migration.sql"),
        "utf8"
      );
      // Run the exact checked-in index DDL to exercise operational pre-creation;
      // Prisma's model API cannot create a concurrent partial index.
      await prisma.$executeRawUnsafe(dueSql);
      for (const migration of migrations.slice(1)) {
        await mkdir(join(directory, "migrations", migration));
        await copyFile(
          join(database, "prisma/migrations", migration, "migration.sql"),
          join(directory, "migrations", migration, "migration.sql")
        );
      }
      await exec("pnpm", ["exec", "prisma", "migrate", "deploy", "--schema", schema], {
        cwd: database,
        env,
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
    const migrated = await prisma.runtimeEnvironment.findFirstOrThrow({
      where: { id: existing.id },
    });
    expect(migrated.archivedAt).toBeNull();
    expect(migrated.previewAutoArchiveNextCheckAt).toBeNull();
    expect(migrated.previewAutoArchiveExcludedBranches).toEqual([]);
    await savePreviewAutoArchivePolicy(prisma, parent.id, { days: 14, excludedBranches: [] }, now);
    expect((await processPreviewAutoArchivePage(prisma, 0, now))?.archived).toHaveLength(1);
    // Index validity lives in PostgreSQL catalogs, which are not Prisma models.
    // Inspect the real build results rather than assuming migration success implies validity.
    const indexes = await prisma.$queryRaw<
      Array<{ relname: string; indisvalid: boolean }>
    >`SELECT c.relname, i.indisvalid FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid WHERE c.relname IN ('RuntimeEnvironment_preview_archive_due_idx', 'RuntimeEnvironment_preview_archive_scan_idx')`;
    expect(indexes).toHaveLength(2);
    expect(indexes.every((i) => i.indisvalid)).toBe(true);
  },
  60_000
);
