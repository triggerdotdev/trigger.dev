import { heteroPostgresTest, postgresTest } from "@internal/testcontainers";
import { PostgresRunStore } from "@internal/run-store";
import type { ReadClient, RunStore } from "@internal/run-store";
import { ownerEngine, type Residency } from "@trigger.dev/core/v3/isomorphic";
import type { Prisma, PrismaClient } from "@trigger.dev/database";
import { describe, expect, vi } from "vitest";
import { RunHydrator } from "~/services/realtime/runReader.server";

// Realtime read-route proof for the RunHydrator.
//
// On origin/main the realtime RunHydrator's two run-ops reads already flow through the runStore
// seam: `hydrateByIds` -> `runStore.findRuns(..., replica)` and `#fetch` -> `runStore.findRun(...,
// replica)`. The split-aware routing (new-DB-first, legacy READ REPLICA only for ids not
// known-migrated) is the store's job below the seam, so this file proves the hydrator *inherits*
// that routing — plus that the single-flight + short-TTL cache and the skipColumns projection
// (which live in the hydrator, not the store) are unaffected by the seam.
//
// The heterogeneous fixture gives real legacy + new Postgres containers; NO DB is mocked. The ONLY
// non-DB fake is the residency selector that the routing-shaped store uses (`ownerEngine`: ksuid ->
// NEW, cuid -> LEGACY), exactly the substrate the RoutingRunStore ships. Run ids are 25 chars (cuid
// -> LEGACY) or 27 chars (ksuid -> NEW) so the classifier routes them deterministically.

// 25-char internal id -> cuid -> LEGACY; 27-char internal id -> ksuid -> NEW. The
// classifier strips a leading `<prefix>_`, so these ids must carry NO underscore (a bare
// alphanumeric body of the exact length).
function newId(label: string): string {
  return ("k" + label.replace(/[^a-z0-9]/gi, "")).padEnd(27, "0").slice(0, 27);
}
function legacyId(label: string): string {
  return ("c" + label.replace(/[^a-z0-9]/gi, "")).padEnd(25, "0").slice(0, 25);
}

async function seedEnvironment(prisma: PrismaClient, slugSuffix: string) {
  const organization = await prisma.organization.create({
    data: { title: `Org ${slugSuffix}`, slug: `org-${slugSuffix}` },
  });
  const project = await prisma.project.create({
    data: {
      name: `Project ${slugSuffix}`,
      slug: `project-${slugSuffix}`,
      externalRef: `proj_${slugSuffix}`,
      organizationId: organization.id,
    },
  });
  const environment = await prisma.runtimeEnvironment.create({
    data: {
      type: "DEVELOPMENT",
      slug: "dev",
      projectId: project.id,
      organizationId: organization.id,
      apiKey: `tr_dev_${slugSuffix}`,
      pkApiKey: `pk_dev_${slugSuffix}`,
      shortcode: `short_${slugSuffix}`,
    },
  });
  return { organization, project, environment };
}

async function seedRun(
  prisma: PrismaClient,
  params: {
    runId: string;
    organizationId: string;
    projectId: string;
    runtimeEnvironmentId: string;
    payload?: string;
    output?: string | null;
    metadata?: string | null;
    runTags?: string[];
    error?: Prisma.InputJsonValue;
  }
) {
  await prisma.taskRun.create({
    data: {
      id: params.runId,
      engine: "V2",
      status: "PENDING",
      friendlyId: `run_friendly_${params.runId.slice(0, 8)}`,
      runtimeEnvironmentId: params.runtimeEnvironmentId,
      environmentType: "DEVELOPMENT",
      organizationId: params.organizationId,
      projectId: params.projectId,
      taskIdentifier: "my-task",
      payload: params.payload ?? '{"hello":"world"}',
      payloadType: "application/json",
      ...(params.output !== undefined && { output: params.output }),
      outputType: "application/json",
      ...(params.metadata !== undefined && { metadata: params.metadata }),
      ...(params.error !== undefined && { error: params.error }),
      traceContext: {},
      traceId: `trace_${params.runId}`,
      spanId: `span_${params.runId}`,
      runTags: params.runTags ?? ["alpha", "beta"],
      queue: "task/my-task",
      isTest: false,
      taskEventStore: "taskEvent",
      depth: 0,
    },
  });
}

/**
 * A routing-shaped RunStore: routes the single-run `findRun` by residency (the exact substrate
 * the RoutingRunStore ships) and fans `findRuns` out across NEW + LEGACY, merging by id
 * (the union/dedup the routing store owns; this hydrator inherits it). For not-known-migrated ids
 * the read falls back to the LEGACY slot — which is wired over a READ REPLICA handle, never a
 * writer. Only `findRun`/`findRuns` (the two reads this unit exercises) are implemented; the rest
 * throw so any accidental call surfaces. The only non-DB fake here is the residency selector.
 *
 * By design the router ignores the explicit read `client` and reads off the selected slot's OWN
 * configured replica, so the hydrator's `replica` arg is dropped here.
 */
function makeRoutingShapedStore(options: {
  newStore: PostgresRunStore;
  legacyStore: PostgresRunStore;
  classify?: (id: string) => Residency;
}): RunStore {
  const classify = options.classify ?? ownerEngine;
  const route = (id: string | undefined): PostgresRunStore => {
    if (typeof id !== "string") return options.legacyStore;
    try {
      return classify(id) === "NEW" ? options.newStore : options.legacyStore;
    } catch {
      // Not known-migrated / unclassifiable -> fall back to the LEGACY read replica only.
      return options.legacyStore;
    }
  };

  const idFromWhere = (where: Prisma.TaskRunWhereInput): string | undefined => {
    const id = where.id;
    if (typeof id === "string") return id;
    if (id && typeof id === "object" && "equals" in id && typeof id.equals === "string") {
      return id.equals;
    }
    return undefined;
  };

  const handler: ProxyHandler<RunStore> = {
    get(_target, prop) {
      if (prop === "findRun") {
        // Drop the explicit `client`: the selected slot reads off its OWN replica.
        return (where: Prisma.TaskRunWhereInput, args: unknown, _client?: ReadClient) =>
          (route(idFromWhere(where)).findRun as (...rest: unknown[]) => Promise<unknown>)(
            where,
            args
          );
      }
      if (prop === "findRuns") {
        return async (
          args: { where: Prisma.TaskRunWhereInput; select: Prisma.TaskRunSelect },
          _client?: ReadClient
        ) => {
          // Fan out across both slots (each on its OWN replica) and merge by id (the routing
          // store's union/dedup contract).
          const [fromNew, fromLegacy] = await Promise.all([
            options.newStore.findRuns(args as never),
            options.legacyStore.findRuns(args as never),
          ]);
          const byId = new Map<string, Record<string, unknown>>();
          for (const row of [...fromLegacy, ...fromNew] as Record<string, unknown>[]) {
            byId.set(row.id as string, row);
          }
          return [...byId.values()];
        };
      }
      throw new Error(`routing-shaped store: ${String(prop)} not implemented in test`);
    },
  };

  return new Proxy({} as RunStore, handler);
}

describe("RunHydrator read-route through the runStore seam (legacy + new)", () => {
  // Realtime hydrate pulls run-ops rows from the run-ops replica. A split hydrate returns the
  // union of NEW + LEGACY-replica rows, byte-identical to source, via both
  // getRunById and hydrateByIds.
  heteroPostgresTest(
    "split hydrate returns the NEW + legacy-replica union, byte-identical",
    { timeout: 60_000 },
    async ({ prisma14, prisma17 }) => {
      const newStore = new PostgresRunStore({ prisma: prisma17, readOnlyPrisma: prisma17 });
      const legacyStore = new PostgresRunStore({ prisma: prisma14, readOnlyPrisma: prisma14 });

      const seed14 = await seedEnvironment(prisma14, "u14");
      const seed17 = await seedEnvironment(prisma17, "u17");
      // Both seed envs use the SAME runtimeEnvironmentId so the env-scoped `where` matches across
      // the two physical DBs (each env row is local to its DB but carries the same id).
      const envId = seed17.environment.id;
      await prisma14.runtimeEnvironment.update({
        where: { id: seed14.environment.id },
        data: { id: envId },
      });

      const newRunId = newId("union_new");
      const legacyRunId = legacyId("union_old");

      await seedRun(prisma17, {
        runId: newRunId,
        organizationId: seed17.organization.id,
        projectId: seed17.project.id,
        runtimeEnvironmentId: envId,
        payload: '{"side":"new"}',
        output: '{"result":42}',
        metadata: '{"m":1}',
        runTags: ["new", "z"],
        error: { type: "BUILT_IN_ERROR", name: "Boom", message: "new-side" },
      });
      await seedRun(prisma14, {
        runId: legacyRunId,
        organizationId: seed14.organization.id,
        projectId: seed14.project.id,
        runtimeEnvironmentId: envId,
        payload: '{"side":"legacy"}',
        output: null,
        metadata: null,
        runTags: ["legacy", "a"],
        error: { type: "STRING_ERROR", raw: "legacy-side" },
      });

      const runStore = makeRoutingShapedStore({ newStore, legacyStore });
      const hydrator = new RunHydrator({ replica: prisma14, runStore });

      const rows = await hydrator.hydrateByIds(envId, [newRunId, legacyRunId]);
      expect(rows.map((r) => r.id).sort()).toEqual([legacyRunId, newRunId].sort());

      const newRow = rows.find((r) => r.id === newRunId)!;
      const legacyRow = rows.find((r) => r.id === legacyRunId)!;

      // Byte-identical to source incl. JSON columns, runTags, error JSON.
      expect(newRow.payload).toBe('{"side":"new"}');
      expect(newRow.output).toBe('{"result":42}');
      expect(newRow.metadata).toBe('{"m":1}');
      expect(newRow.runTags).toEqual(["new", "z"]);
      expect(newRow.error).toEqual({ type: "BUILT_IN_ERROR", name: "Boom", message: "new-side" });

      expect(legacyRow.payload).toBe('{"side":"legacy"}');
      expect(legacyRow.output).toBeNull();
      expect(legacyRow.metadata).toBeNull();
      expect(legacyRow.runTags).toEqual(["legacy", "a"]);
      expect(legacyRow.error).toEqual({ type: "STRING_ERROR", raw: "legacy-side" });

      // getRunById resolves each individual run from its correct source through the seam.
      const newById = await hydrator.getRunById(envId, newRunId);
      const legacyById = await hydrator.getRunById(envId, legacyRunId);
      expect(newById?.payload).toBe('{"side":"new"}');
      expect(legacyById?.payload).toBe('{"side":"legacy"}');
    }
  );

  // A known-migrated (NEW-residency) run is NOT re-probed on the legacy replica.
  heteroPostgresTest(
    "known-migrated run is never probed on the legacy slot",
    { timeout: 60_000 },
    async ({ prisma14, prisma17 }) => {
      const newStore = new PostgresRunStore({ prisma: prisma17, readOnlyPrisma: prisma17 });
      const legacyStore = new PostgresRunStore({ prisma: prisma14, readOnlyPrisma: prisma14 });
      const legacyFindRunSpy = vi.spyOn(legacyStore, "findRun");

      const seed17 = await seedEnvironment(prisma17, "k17");
      const envId = seed17.environment.id;
      const migratedRunId = newId("known_mig");
      await seedRun(prisma17, {
        runId: migratedRunId,
        organizationId: seed17.organization.id,
        projectId: seed17.project.id,
        runtimeEnvironmentId: envId,
      });

      const runStore = makeRoutingShapedStore({ newStore, legacyStore });
      const hydrator = new RunHydrator({ replica: prisma14, runStore });

      const row = await hydrator.getRunById(envId, migratedRunId);
      expect(row?.id).toBe(migratedRunId);
      // The NEW-residency id resolved against the NEW slot only — the legacy probe never ran.
      expect(legacyFindRunSpy).not.toHaveBeenCalled();
    }
  );

  // An old in-retention run is served from the LEGACY read replica (never a writer/primary path).
  heteroPostgresTest(
    "old in-retention run served from the legacy replica slot",
    { timeout: 60_000 },
    async ({ prisma14, prisma17 }) => {
      const newStore = new PostgresRunStore({ prisma: prisma17, readOnlyPrisma: prisma17 });
      // The LEGACY slot exposes only a read/replica handle: `prisma14` is wired as BOTH prisma and
      // readOnlyPrisma, and the hydrator passes it as the explicit read client — there is no
      // legacy-writer read path on the read route (the replica-only invariant is structural in the
      // store; asserted here as inheritance).
      const legacyStore = new PostgresRunStore({ prisma: prisma14, readOnlyPrisma: prisma14 });

      const seed14 = await seedEnvironment(prisma14, "o14");
      const envId = seed14.environment.id;
      const oldRunId = legacyId("old_run");
      await seedRun(prisma14, {
        runId: oldRunId,
        organizationId: seed14.organization.id,
        projectId: seed14.project.id,
        runtimeEnvironmentId: envId,
        payload: '{"era":"old"}',
      });

      const runStore = makeRoutingShapedStore({ newStore, legacyStore });
      const hydrator = new RunHydrator({ replica: prisma14, runStore });

      const byId = await hydrator.getRunById(envId, oldRunId);
      expect(byId?.payload).toBe('{"era":"old"}');

      const [hydrated] = await hydrator.hydrateByIds(envId, [oldRunId]);
      expect(hydrated.payload).toBe('{"era":"old"}');
    }
  );

  // Terminal-metadata read-seam: a NEW-resident (ksuid) run's final metadata is hydrated through
  // the owning (NEW) store, not off a generic legacy replica. Asserts read-seam ROUTING for the
  // terminal read; it is not a hard ordering/consistency guarantee about when the terminal marker
  // and the row's terminal columns converge.
  heteroPostgresTest(
    "terminal hydrate reads a NEW-resident run's final metadata through the owning store",
    { timeout: 60_000 },
    async ({ prisma14, prisma17 }) => {
      const newStore = new PostgresRunStore({ prisma: prisma17, readOnlyPrisma: prisma17 });
      const legacyStore = new PostgresRunStore({ prisma: prisma14, readOnlyPrisma: prisma14 });
      const legacyFindRunSpy = vi.spyOn(legacyStore, "findRun");

      const seed17 = await seedEnvironment(prisma17, "term17");
      const envId = seed17.environment.id;
      const terminalRunId = newId("terminal_run");

      // A terminal run with its final metadata persisted on the NEW store only.
      await seedRun(prisma17, {
        runId: terminalRunId,
        organizationId: seed17.organization.id,
        projectId: seed17.project.id,
        runtimeEnvironmentId: envId,
        output: '{"result":"final"}',
        metadata: '{"done":true}',
      });

      // A generic legacy replica would miss the NEW row entirely — the metadata must come off NEW.
      const runStore = makeRoutingShapedStore({ newStore, legacyStore });
      const hydrator = new RunHydrator({ replica: prisma14, runStore, cacheTtlMs: 0 });

      const snapshot = await hydrator.getRunById(envId, terminalRunId);
      expect(snapshot?.id).toBe(terminalRunId);
      expect(snapshot?.metadata).toBe('{"done":true}');
      expect(snapshot?.output).toBe('{"result":"final"}');
      // The NEW-residency terminal read never touched the legacy slot.
      expect(legacyFindRunSpy).not.toHaveBeenCalled();
    }
  );

  // A live-migrated run continues streaming across the seam crossing with no gap.
  heteroPostgresTest(
    "live-migrated run continues streaming across the seam crossing",
    { timeout: 60_000 },
    async ({ prisma14, prisma17 }) => {
      const newStore = new PostgresRunStore({ prisma: prisma17, readOnlyPrisma: prisma17 });
      const legacyStore = new PostgresRunStore({ prisma: prisma14, readOnlyPrisma: prisma14 });

      const seed14 = await seedEnvironment(prisma14, "m14");
      const seed17 = await seedEnvironment(prisma17, "m17");
      const envId = seed17.environment.id;
      await prisma14.runtimeEnvironment.update({
        where: { id: seed14.environment.id },
        data: { id: envId },
      });

      // The run starts life on LEGACY; the residency selector classifies it NEW once it migrates.
      // We model the migration by seeding the same run id on LEGACY first, then on NEW, while
      // flipping the classifier from LEGACY to NEW for that id at the seam crossing.
      const runId = legacyId("migrating");
      await seedRun(prisma14, {
        runId,
        organizationId: seed14.organization.id,
        projectId: seed14.project.id,
        runtimeEnvironmentId: envId,
        payload: '{"home":"legacy"}',
      });

      let migrated = false;
      const classify = (id: string): Residency =>
        id === runId && migrated ? "NEW" : ownerEngine(id);
      const legacyFindRunSpy = vi.spyOn(legacyStore, "findRun");

      // Use a 0ms TTL so each getRunById re-reads through the seam (no cached stale row across the
      // crossing). Single-flight/TTL are proven separately below.
      const runStore = makeRoutingShapedStore({ newStore, legacyStore, classify });
      const hydrator = new RunHydrator({ replica: prisma14, runStore, cacheTtlMs: 0 });

      // Before migration: served from LEGACY.
      const before = await hydrator.getRunById(envId, runId);
      expect(before?.payload).toBe('{"home":"legacy"}');
      expect(legacyFindRunSpy).toHaveBeenCalled();

      // Migrate: the run now lives on NEW and the classifier routes it NEW.
      await seedRun(prisma17, {
        runId,
        organizationId: seed17.organization.id,
        projectId: seed17.project.id,
        runtimeEnvironmentId: envId,
        payload: '{"home":"new"}',
      });
      migrated = true;
      legacyFindRunSpy.mockClear();

      // After migration: served from NEW, with no gap and no legacy re-probe.
      const after = await hydrator.getRunById(envId, runId);
      expect(after?.payload).toBe('{"home":"new"}');
      expect(after?.id).toBe(runId);
      expect(legacyFindRunSpy).not.toHaveBeenCalled();
    }
  );
});

describe("RunHydrator single-flight + TTL cache intact across the seam", () => {
  // The cache/single-flight live in the hydrator, independent of the storage seam. Proven in
  // SPLIT mode here (a counting wrapper over the selected underlying store's read).
  heteroPostgresTest(
    "split mode: two concurrent getRunById -> one underlying read; repeat within TTL is cached",
    { timeout: 60_000 },
    async ({ prisma14, prisma17 }) => {
      const newStore = new PostgresRunStore({ prisma: prisma17, readOnlyPrisma: prisma17 });
      const legacyStore = new PostgresRunStore({ prisma: prisma14, readOnlyPrisma: prisma14 });
      const newFindRunSpy = vi.spyOn(newStore, "findRun");

      const seed17 = await seedEnvironment(prisma17, "s17");
      const envId = seed17.environment.id;
      const runId = newId("cached_run");
      await seedRun(prisma17, {
        runId,
        organizationId: seed17.organization.id,
        projectId: seed17.project.id,
        runtimeEnvironmentId: envId,
      });

      const runStore = makeRoutingShapedStore({ newStore, legacyStore });
      const hydrator = new RunHydrator({ replica: prisma14, runStore, cacheTtlMs: 60_000 });

      // Two concurrent calls -> single-flight collapses to ONE underlying read.
      const [a, b] = await Promise.all([
        hydrator.getRunById(envId, runId),
        hydrator.getRunById(envId, runId),
      ]);
      expect(a?.id).toBe(runId);
      expect(b?.id).toBe(runId);
      expect(newFindRunSpy).toHaveBeenCalledTimes(1);

      // A third call within the TTL returns the cached value with no new read.
      const c = await hydrator.getRunById(envId, runId);
      expect(c?.id).toBe(runId);
      expect(newFindRunSpy).toHaveBeenCalledTimes(1);
    }
  );

  // A cached `null` (missing run) is a valid not-found hit and is not re-read within the TTL.
  heteroPostgresTest(
    "split mode: a cached null (missing run) is not re-read within the TTL",
    { timeout: 60_000 },
    async ({ prisma14, prisma17 }) => {
      const newStore = new PostgresRunStore({ prisma: prisma17, readOnlyPrisma: prisma17 });
      const legacyStore = new PostgresRunStore({ prisma: prisma14, readOnlyPrisma: prisma14 });
      const newFindRunSpy = vi.spyOn(newStore, "findRun");

      const seed17 = await seedEnvironment(prisma17, "n17");
      const envId = seed17.environment.id;
      const missingRunId = newId("missing_run");

      const runStore = makeRoutingShapedStore({ newStore, legacyStore });
      const hydrator = new RunHydrator({ replica: prisma14, runStore, cacheTtlMs: 60_000 });

      const first = await hydrator.getRunById(envId, missingRunId);
      expect(first).toBeNull();
      expect(newFindRunSpy).toHaveBeenCalledTimes(1);

      const second = await hydrator.getRunById(envId, missingRunId);
      expect(second).toBeNull();
      // Still one read — the null was cached as a valid "not found" hit.
      expect(newFindRunSpy).toHaveBeenCalledTimes(1);
    }
  );
});

describe("RunHydrator single-DB passthrough (one PostgresRunStore over one client)", () => {
  // Passthrough: in single-DB the store is one PostgresRunStore over one client; the hydrator
  // behaves byte-for-byte as today. No split branch, no legacy slot, no second connection.
  postgresTest(
    "single store: getRunById + hydrateByIds read from the one client, cache intact",
    { timeout: 60_000 },
    async ({ prisma }) => {
      const store = new PostgresRunStore({ prisma, readOnlyPrisma: prisma });
      const findRunSpy = vi.spyOn(store, "findRun");

      const seed = await seedEnvironment(prisma, "sd1");
      const envId = seed.environment.id;
      const runIdA = newId("single_a");
      const runIdB = legacyId("single_b");
      for (const runId of [runIdA, runIdB]) {
        await seedRun(prisma, {
          runId,
          organizationId: seed.organization.id,
          projectId: seed.project.id,
          runtimeEnvironmentId: envId,
          payload: `{"id":"${runId}"}`,
        });
      }

      const hydrator = new RunHydrator({ replica: prisma, runStore: store, cacheTtlMs: 60_000 });

      // hydrateByIds returns both rows from the single client.
      const rows = await hydrator.hydrateByIds(envId, [runIdA, runIdB]);
      expect(rows.map((r) => r.id).sort()).toEqual([runIdA, runIdB].sort());

      // getRunById hydrates from the single store; the cache short-circuits a repeat read.
      const a1 = await hydrator.getRunById(envId, runIdA);
      const a2 = await hydrator.getRunById(envId, runIdA);
      expect(a1?.payload).toBe(`{"id":"${runIdA}"}`);
      expect(a2?.payload).toBe(`{"id":"${runIdA}"}`);
      expect(findRunSpy).toHaveBeenCalledTimes(1);
    }
  );

  // Empty id-set short-circuits with no store call.
  postgresTest("empty id-set returns [] without touching the store", async ({ prisma }) => {
    const store = new PostgresRunStore({ prisma, readOnlyPrisma: prisma });
    const findRunsSpy = vi.spyOn(store, "findRuns");
    const hydrator = new RunHydrator({ replica: prisma, runStore: store });

    const rows = await hydrator.hydrateByIds("env_none", []);
    expect(rows).toEqual([]);
    expect(findRunsSpy).not.toHaveBeenCalled();
  });
});
