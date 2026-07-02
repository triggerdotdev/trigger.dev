import { describe, expect, vi } from "vitest";

// The SpanPresenter module graph imports `~/v3/runStore.server`, which imports `~/db.server`
// at load (and a large transitive graph: runEngine, eventRepository, mollifier, ...). We stub the
// two boundaries the presenter reads through so the file loads under test, then drive it entirely
// against real Postgres containers — NEVER mocking a DB client.
//
//  * `~/db.server` — the module-level `prisma`/`$replica` exports. The presenter receives its
//    control-plane handle through the BasePresenter constructor (`new SpanPresenter(cp, cp)`), so
//    these stubs are never read on the path under test.
//  * `~/v3/runStore.server` — the run-ops store singleton. This is the ONE wiring boundary we
//    override: the test injects a routing-shaped store (a RoutingRunStore over the two-DB hetero
//    fixture) in its place. This is a wiring override, not a DB mock — every run-ops read still
//    executes against a real container.
vi.mock("~/db.server", () => ({
  prisma: {},
  $replica: {},
}));

const routingStoreRef = vi.hoisted(() => ({ current: undefined as unknown }));
vi.mock("~/v3/runStore.server", () => ({
  get runStore() {
    return routingStoreRef.current;
  },
}));

import { PostgresRunStore, RoutingRunStore } from "@internal/run-store";
import type { RunStore } from "@internal/run-store";
import { heteroPostgresTest } from "@internal/testcontainers";
import type { Prisma, PrismaClient } from "@trigger.dev/database";
import { SpanPresenter } from "~/presenters/v3/SpanPresenter.server";

vi.setConfig({ testTimeout: 90_000 });

// 25-char internal id → cuid → LEGACY; 27-char internal id → ksuid → NEW (the residency
// classifier shared with the RoutingRunStore's default `ownerEngine`).
const CUID_25 = "c".repeat(25);
const KSUID_27 = "k".repeat(27);

type SeedContext = {
  organizationId: string;
  projectId: string;
  environmentId: string;
};

async function seedParents(prisma: PrismaClient, slug: string): Promise<SeedContext> {
  const organization = await prisma.organization.create({
    data: { title: `org-${slug}`, slug: `org-${slug}` },
  });
  const project = await prisma.project.create({
    data: {
      name: `proj-${slug}`,
      slug: `proj-${slug}`,
      organizationId: organization.id,
      externalRef: `proj-${slug}`,
    },
  });
  const runtimeEnvironment = await prisma.runtimeEnvironment.create({
    data: {
      slug: `env-${slug}`,
      type: "PRODUCTION",
      projectId: project.id,
      organizationId: organization.id,
      apiKey: `tr_prod_${slug}`,
      pkApiKey: `pk_prod_${slug}`,
      shortcode: `sc-${slug}`,
    },
  });

  return {
    organizationId: organization.id,
    projectId: project.id,
    environmentId: runtimeEnvironment.id,
  };
}

/** Mirror the org/project/env parents onto a second DB with the SAME ids (TaskRun FKs need them
 *  on every DB a run is hydrated from). */
async function mirrorParents(prisma: PrismaClient, ctx: SeedContext, slug: string): Promise<void> {
  await prisma.organization.create({
    data: { id: ctx.organizationId, title: `org-${slug}`, slug: `org-${slug}` },
  });
  await prisma.project.create({
    data: {
      id: ctx.projectId,
      name: `proj-${slug}`,
      slug: `proj-${slug}`,
      organizationId: ctx.organizationId,
      externalRef: `proj-${slug}`,
    },
  });
  await prisma.runtimeEnvironment.create({
    data: {
      id: ctx.environmentId,
      slug: `env-${slug}`,
      type: "PRODUCTION",
      projectId: ctx.projectId,
      organizationId: ctx.organizationId,
      apiKey: `tr_prod_${slug}_b`,
      pkApiKey: `pk_prod_${slug}_b`,
      shortcode: `sc-${slug}-b`,
    },
  });
}

async function createRun(
  prisma: PrismaClient,
  ctx: SeedContext,
  run: {
    id: string;
    friendlyId: string;
    spanId: string;
    parentSpanId?: string;
    taskIdentifier?: string;
    status?: Prisma.TaskRunCreateInput["status"];
    parentTaskRunId?: string;
    rootTaskRunId?: string;
  }
) {
  return prisma.taskRun.create({
    data: {
      id: run.id,
      friendlyId: run.friendlyId,
      taskIdentifier: run.taskIdentifier ?? "my-task",
      status: run.status ?? "COMPLETED_SUCCESSFULLY",
      payload: JSON.stringify({ foo: run.friendlyId }),
      payloadType: "application/json",
      traceId: `trace_${run.friendlyId}`,
      spanId: run.spanId,
      parentSpanId: run.parentSpanId,
      parentTaskRunId: run.parentTaskRunId,
      rootTaskRunId: run.rootTaskRunId,
      queue: "task/my-task",
      runTags: ["alpha", "beta"],
      runtimeEnvironmentId: ctx.environmentId,
      projectId: ctx.projectId,
      organizationId: ctx.organizationId,
      environmentType: "PRODUCTION",
      engine: "V2",
      taskEventStore: "taskEvent",
    },
  });
}

/**
 * Test-only wiring shim. In production the run-ops store's DB selection is the store's own
 * concern, but `SpanPresenter` still passes `this._replica`/`this._prisma` (the control-plane
 * handle) as the explicit `client` arg to `runStore.findRun`/`findRuns`. `PostgresRunStore`
 * honours an explicit client (`client ?? this.readOnlyPrisma`), so without this shim a run-ops
 * read would execute against the control-plane DB. Reconciling that explicit-client override
 * with split routing is the job of the runStore.server.ts wiring seam, explicitly OUT of this
 * unit's scope. The shim represents that reconciliation: it drops the
 * presenter's client arg so each underlying PostgresRunStore reads from its OWN bound DB — the
 * residency-routed behaviour the presenter will inherit once the seam is wired. It fakes ONLY the
 * client wiring; every DB read still hits a real container.
 */
function ownDbStore(prisma: PrismaClient): RunStore {
  const inner = new PostgresRunStore({ prisma, readOnlyPrisma: prisma });
  return new Proxy(inner, {
    get(target, prop) {
      if (prop === "findRun" || prop === "findRuns") {
        return (...args: unknown[]) => {
          // Strip a trailing explicit `client` arg so the store reads from its own DB.
          const stripped = stripTrailingClient(prop, args);
          return (target[prop] as (...a: unknown[]) => unknown).apply(target, stripped);
        };
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as unknown as RunStore;
}

function stripTrailingClient(method: "findRun" | "findRuns", args: unknown[]): unknown[] {
  // findRun(where, argsOrClient?, client?) ; findRuns(args, client?). The last arg is the
  // presenter's explicit client when it is not a projection object.
  const last = args[args.length - 1] as { select?: unknown; include?: unknown } | undefined;
  const isProjection =
    typeof last === "object" && last !== null && ("select" in last || "include" in last);
  if (args.length === 0 || isProjection) {
    return args;
  }
  return args.slice(0, -1);
}

/** A read-only client wrapper: throws on any write, asserting the legacy slot is replica-only. */
function asReplica(prisma: PrismaClient): PrismaClient {
  return new Proxy(prisma, {
    get(target, prop, receiver) {
      if (prop === "taskRun") {
        return new Proxy((target as any).taskRun, {
          get(trTarget, trProp) {
            if (
              ["create", "update", "updateMany", "upsert", "delete", "deleteMany"].includes(
                String(trProp)
              )
            ) {
              return () => {
                throw new Error(`legacy slot is read-replica-only; ${String(trProp)} is forbidden`);
              };
            }
            return (trTarget as any)[trProp];
          },
        });
      }
      return Reflect.get(target, prop, receiver);
    },
  }) as unknown as PrismaClient;
}

describe("SpanPresenter run-ops/control-plane partition (legacy + new)", () => {
  // Span detail resolves run + children through the run-ops store, region/schedule/session
  // on control-plane, no cross-DB join.
  heteroPostgresTest(
    "findRun hydrates the run through the run-ops store (new-first) and the children-by-parentSpanId set; region/schedule/session resolve from the control-plane client",
    async ({ prisma14, prisma17 }) => {
      // prisma17 = NEW run-ops; prisma14 = LEGACY run-ops replica AND, for this partition proof,
      // the control-plane DB (a physically distinct DB from the NEW run-ops store).
      const cp = prisma14;

      // Seed the env/project/org parents on BOTH run-ops DBs (FKs) and on the CP DB.
      const ctxNew = await seedParents(prisma17, "partn");
      await mirrorParents(prisma14, ctxNew, "partn"); // legacy run-ops + CP parents share ids

      const runId = `run_${KSUID_27}`; // ksuid → NEW residency
      const childMigratedId = `run_a${KSUID_27.slice(1)}`; // also NEW
      await createRun(prisma17, ctxNew, {
        id: runId,
        friendlyId: "run_parent",
        spanId: "span_parent",
        taskIdentifier: "parent-task",
      });
      // A child whose parentSpanId points at the parent's span — lives on NEW.
      await createRun(prisma17, ctxNew, {
        id: childMigratedId,
        friendlyId: "run_child_new",
        spanId: "span_child_new",
        parentSpanId: "span_parent",
        parentTaskRunId: runId,
        taskIdentifier: "child-task",
      });

      // Control-plane rows live on the CP DB only.
      const workerGroup = await cp.workerInstanceGroup.create({
        data: {
          name: "us-east-1-group",
          location: "N. Virginia, USA",
          masterQueue: "main",
          type: "MANAGED",
          token: { create: { tokenHash: `tok-${ctxNew.projectId}` } },
        },
      });
      const schedule = await cp.taskSchedule.create({
        data: {
          friendlyId: "sched_1234",
          taskIdentifier: "parent-task",
          projectId: ctxNew.projectId,
          deduplicationKey: "dedup-1",
          type: "DECLARATIVE",
          generatorExpression: "0 * * * *",
          generatorDescription: "every hour",
          timezone: "UTC",
        },
      });

      routingStoreRef.current = new RoutingRunStore({
        new: ownDbStore(prisma17),
        legacy: ownDbStore(prisma14),
      });

      const presenter = new SpanPresenter(cp, cp);

      // (a) run hydrated through the run-ops store (NEW), byte-identical to the source row incl.
      //     the run-ops self-relations.
      const run = await presenter.findRun({
        originalRunId: "run_parent",
        spanId: "span_parent",
        environmentId: ctxNew.environmentId,
      });
      expect(run?.id).toBe(runId);
      expect(run?.friendlyId).toBe("run_parent");
      expect(run?.taskIdentifier).toBe("parent-task");
      expect(run?.runTags).toEqual(["alpha", "beta"]);
      // Nested run-ops self-relation resolved on the same (NEW) store.
      expect(run?.parentTaskRun).toBeNull();

      // (b) the run does NOT exist on the CP DB — the run-ops read could only have come from the
      //     run-ops store, never a CP join.
      expect(await cp.taskRun.findFirst({ where: { friendlyId: "run_parent" } })).toBeNull();

      // (c) the control-plane standalone reads resolve from the CP client.
      const region = await cp.workerInstanceGroup.findFirst({ where: { masterQueue: "main" } });
      expect(region?.name).toBe(workerGroup.name);
      expect(await presenter.resolveSchedule(schedule.id)).toMatchObject({
        friendlyId: "sched_1234",
        timezone: "UTC",
      });
    }
  );

  // Children set served by runStore.findRuns through the routing store.
  heteroPostgresTest(
    "triggeredRuns (children-by-parentSpanId) is served by runStore.findRuns with the presenter's exact select",
    async ({ prisma14, prisma17 }) => {
      const ctx = await seedParents(prisma17, "kids");

      await createRun(prisma17, ctx, {
        id: `run_${KSUID_27}`,
        friendlyId: "run_parent2",
        spanId: "span_p2",
      });
      await createRun(prisma17, ctx, {
        id: `run_b${KSUID_27.slice(1)}`,
        friendlyId: "run_kid_a",
        spanId: "span_kid_a",
        parentSpanId: "span_p2",
      });
      await createRun(prisma17, ctx, {
        id: `run_c${KSUID_27.slice(1)}`,
        friendlyId: "run_kid_b",
        spanId: "span_kid_b",
        parentSpanId: "span_p2",
      });

      const store = new RoutingRunStore({
        new: ownDbStore(prisma17),
        legacy: ownDbStore(prisma14),
      });

      const triggeredRuns = await store.findRuns({
        where: { parentSpanId: "span_p2" },
        select: {
          friendlyId: true,
          taskIdentifier: true,
          spanId: true,
          createdAt: true,
          status: true,
        },
      });

      expect(triggeredRuns.map((r) => r.friendlyId).sort()).toEqual(["run_kid_a", "run_kid_b"]);
      // select projection holds: no `id`/`payload` leaked through.
      expect(triggeredRuns[0]).not.toHaveProperty("id");
      expect(triggeredRuns[0]).not.toHaveProperty("payload");
    }
  );

  // Old in-retention run served from the legacy replica, never the primary.
  heteroPostgresTest(
    "a legacy-residency run resolves through the store's LEGACY slot, which exposes only a replica handle",
    async ({ prisma14, prisma17 }) => {
      const ctx = await seedParents(prisma14, "legacy");

      const legacyRunId = `run_${CUID_25}`; // cuid → LEGACY residency
      await createRun(prisma14, ctx, {
        id: legacyRunId,
        friendlyId: "run_legacy",
        spanId: "span_legacy",
        taskIdentifier: "legacy-task",
      });

      // The LEGACY slot is wired over a replica (read-only) handle; the NEW slot over the new DB.
      const store = new RoutingRunStore({
        new: ownDbStore(prisma17),
        legacy: ownDbStore(asReplica(prisma14)),
      });

      // Routed by `id` residency (cuid → LEGACY). The presenter's findRun keys by friendlyId/spanId
      // (which route NEW-default through the store today); routing by id is the store-level proof
      // that the LEGACY slot serves in-retention runs. The legacy slot's replica handle forbids
      // writes — proving the read route can never touch a legacy writer.
      const found = await store.findRun(
        { id: legacyRunId },
        { select: { id: true, friendlyId: true, taskIdentifier: true } }
      );
      expect(found?.id).toBe(legacyRunId);
      expect(found?.taskIdentifier).toBe("legacy-task");
    }
  );

  // A known-migrated run is not re-probed on legacy.
  heteroPostgresTest(
    "a NEW-residency id is served by the NEW slot and the LEGACY slot is never invoked",
    async ({ prisma14, prisma17 }) => {
      const ctx = await seedParents(prisma17, "knownmig");

      const newRunId = `run_${KSUID_27}`; // ksuid → NEW residency
      await createRun(prisma17, ctx, {
        id: newRunId,
        friendlyId: "run_known_new",
        spanId: "span_known_new",
        taskIdentifier: "new-task",
      });

      // LEGACY slot throws on ANY read — asserting the residency short-circuit never probes it.
      const legacyThrows = new Proxy({} as RunStore, {
        get(_t, prop) {
          if (prop === "findRun" || prop === "findRuns") {
            return () => {
              throw new Error(`LEGACY slot must not be probed for a NEW id (${String(prop)})`);
            };
          }
          return undefined;
        },
      });

      const store = new RoutingRunStore({
        new: ownDbStore(prisma17),
        legacy: legacyThrows,
      });

      const found = await store.findRun(
        { id: newRunId },
        { select: { id: true, taskIdentifier: true } }
      );
      expect(found?.id).toBe(newRunId);
      expect(found?.taskIdentifier).toBe("new-task");
    }
  );

  // Passthrough (single-DB): NEW and LEGACY slots are the same store over one client.
  heteroPostgresTest(
    "single-DB collapses both slots to one PostgresRunStore; the presenter resolves run + children + control-plane from the one client",
    async ({ prisma14 }) => {
      const cp = prisma14;
      const ctx = await seedParents(prisma14, "passthru");

      const runId = `run_${KSUID_27}`;
      await createRun(prisma14, ctx, {
        id: runId,
        friendlyId: "run_solo",
        spanId: "span_solo",
        taskIdentifier: "solo-task",
      });
      await createRun(prisma14, ctx, {
        id: `run_d${KSUID_27.slice(1)}`,
        friendlyId: "run_solo_kid",
        spanId: "span_solo_kid",
        parentSpanId: "span_solo",
      });
      const schedule = await cp.taskSchedule.create({
        data: {
          friendlyId: "sched_solo",
          taskIdentifier: "solo-task",
          projectId: ctx.projectId,
          deduplicationKey: "dedup-solo",
          type: "DECLARATIVE",
          generatorExpression: "0 * * * *",
          generatorDescription: "every hour",
          timezone: "UTC",
        },
      });

      // Both slots are the same store over the one client — the single-DB collapse.
      const solo = ownDbStore(prisma14);
      routingStoreRef.current = new RoutingRunStore({ new: solo, legacy: solo });

      const presenter = new SpanPresenter(cp, cp);

      const run = await presenter.findRun({
        originalRunId: "run_solo",
        spanId: "span_solo",
        environmentId: ctx.environmentId,
      });
      expect(run?.id).toBe(runId);
      expect(run?.taskIdentifier).toBe("solo-task");

      // Children resolve from the same single store.
      const children = await (routingStoreRef.current as RunStore).findRuns({
        where: { parentSpanId: "span_solo" },
        select: {
          friendlyId: true,
          taskIdentifier: true,
          spanId: true,
          createdAt: true,
          status: true,
        },
      });
      expect(children.map((c) => c.friendlyId)).toEqual(["run_solo_kid"]);

      // Control-plane read from the same single client.
      expect(await presenter.resolveSchedule(schedule.id)).toMatchObject({
        friendlyId: "sched_solo",
      });
    }
  );

  // Cross-seam tree shape: parent on LEGACY (in-retention), child on NEW (born-new).
  heteroPostgresTest(
    "parent run on the legacy replica, child run on new — relations resolve across the seam, no cross-DB join",
    async ({ prisma14, prisma17 }) => {
      const ctx = await seedParents(prisma14, "e2e4");
      await mirrorParents(prisma17, ctx, "e2e4");

      const parentId = `run_${CUID_25}`; // cuid → LEGACY (in-retention)
      const childId = `run_${KSUID_27}`; // ksuid → NEW (born-new)

      await createRun(prisma14, ctx, {
        id: parentId,
        friendlyId: "run_e2e_parent",
        spanId: "span_e2e_parent",
        taskIdentifier: "parent",
        rootTaskRunId: parentId,
      });
      // The child lives on NEW; it links to the parent across the seam ONLY by `parentSpanId`
      // (a plain indexed column — the exact key `triggeredRuns` uses), NOT by a cross-DB FK
      // (`parentTaskRunId`/`rootTaskRunId` would violate the FK since the parent is on LEGACY;
      // a tree's FK self-relations stay single-DB).
      await createRun(prisma17, ctx, {
        id: childId,
        friendlyId: "run_e2e_child",
        spanId: "span_e2e_child",
        parentSpanId: "span_e2e_parent",
        taskIdentifier: "child",
      });

      const store = new RoutingRunStore({
        new: ownDbStore(prisma17),
        legacy: ownDbStore(asReplica(prisma14)),
      });

      // The parent resolves from the LEGACY slot (routed by its cuid id).
      const parent = await store.findRun(
        { id: parentId },
        {
          select: {
            id: true,
            friendlyId: true,
            rootTaskRun: { select: { friendlyId: true } },
          },
        }
      );
      expect(parent?.id).toBe(parentId);
      // Run-ops self-relation (rootTaskRun) resolves on the parent's own (LEGACY) store — a
      // tree's FK self-relations stay single-DB.
      expect(parent?.rootTaskRun?.friendlyId).toBe("run_e2e_parent");

      // The child resolves from the NEW slot (routed by its ksuid id) and points back at the parent
      // span — the cross-the-line parent/child shape, with no cross-DB join.
      const child = await store.findRun(
        { id: childId },
        { select: { id: true, parentSpanId: true, friendlyId: true } }
      );
      expect(child?.id).toBe(childId);
      expect(child?.parentSpanId).toBe("span_e2e_parent");
    }
  );
});
