// RED→GREEN for the grouped-read primitive `RoutingRunStore.findRunsByIds`.
//
// Today, callers that need N runs by id do `Promise.all(ids.map(id => readThroughRun(id)))`, which
// fans out to `findRun` PER ID — each one either a direct `taskRun.findFirst` on the owning store, or
// (for an unclassifiable id) a NEW-then-LEGACY probe. For N ids that is O(N) round trips.
//
// `findRunsByIds` is the grouped replacement: it reuses the router's existing bounded id-set
// machinery (`#findRunsByIdSet` via `findRuns`), which queries NEW for the WHOLE id set in one
// `findMany`, then probes LEGACY in one more `findMany` only for the ids NEW missed. So for any N
// (spread across both stores), the call count is CONSTANT (one grouped `findMany` per store queried),
// never N `findFirst` calls.
//
// `heteroRunOpsPostgresTest` gives the REAL split topology: prisma17 = dedicated subset schema
// (#new), prisma14 = full legacy schema on a SEPARATE physical PG container (#legacy). The counting
// proxy wraps each REAL client's `taskRun` delegate to tally `findFirst`/`findMany` calls while
// delegating every call to the real client — the DB still runs the query; this is instrumentation,
// not a mock.

import { heteroRunOpsPostgresTest } from "@internal/testcontainers";
import type { PrismaClient } from "@trigger.dev/database";
import type { RunOpsPrismaClient } from "@internal/run-ops-database";
import { describe, expect } from "vitest";
import { PostgresRunStore } from "./PostgresRunStore.js";
import { RoutingRunStore } from "./runOpsStore.js";

type AnyClient = PrismaClient | RunOpsPrismaClient;

// ownerEngine classifies a 26-char body with version "1" at index 25 (and a valid base32hex/region
// char elsewhere) as NEW; anything else (including any 25-char id, regardless of content) as LEGACY.
// The distinguishing prefix varies by `n` so multiple ids in one test stay unique.
const CUID_25 = (n: number) => `c${String(n).padStart(2, "0")}`.padEnd(25, "c");
const NEW_ID_26 = (n: number) => `${String(n).padStart(2, "0")}${"k".repeat(22)}01`;

type CallCounts = { findMany: number; findFirst: number };

// Wrap a REAL client's `taskRun` delegate to tally `findFirst`/`findMany` invocations, delegating
// every call unchanged to the real client (the DB still runs the query — pure instrumentation).
function countingClient<C extends AnyClient>(real: C): { client: C; counts: CallCounts } {
  const counts: CallCounts = { findMany: 0, findFirst: 0 };
  const countingTaskRun = new Proxy((real as any).taskRun, {
    get(target, prop) {
      if (prop === "findMany" || prop === "findFirst") {
        counts[prop as "findMany" | "findFirst"]++;
      }
      return (target as any)[prop];
    },
  });
  const client = new Proxy(real, {
    get(target, prop) {
      if (prop === "taskRun") {
        return countingTaskRun;
      }
      return (target as any)[prop];
    },
  }) as C;
  return { client, counts };
}

async function seedEnvironmentLegacy(prisma: PrismaClient, suffix: string) {
  const organization = await prisma.organization.create({
    data: { title: `Org ${suffix}`, slug: `org-${suffix}` },
  });
  const project = await prisma.project.create({
    data: {
      name: `Project ${suffix}`,
      slug: `project-${suffix}`,
      externalRef: `proj_${suffix}`,
      organizationId: organization.id,
    },
  });
  const environment = await prisma.runtimeEnvironment.create({
    data: {
      type: "DEVELOPMENT",
      slug: "dev",
      projectId: project.id,
      organizationId: organization.id,
      apiKey: `tr_dev_${suffix}`,
      pkApiKey: `pk_dev_${suffix}`,
      shortcode: `short_${suffix}`,
    },
  });
  return { organization, project, environment };
}

function seedEnvironmentDedicated(suffix: string) {
  return {
    organization: { id: `org_${suffix}` },
    project: { id: `proj_${suffix}` },
    environment: { id: `env_${suffix}` },
  };
}

function taskRunData(opts: {
  id: string;
  friendlyId: string;
  organizationId: string;
  projectId: string;
  runtimeEnvironmentId: string;
}) {
  return {
    id: opts.id,
    engine: "V2" as const,
    status: "PENDING" as const,
    friendlyId: opts.friendlyId,
    runtimeEnvironmentId: opts.runtimeEnvironmentId,
    environmentType: "DEVELOPMENT" as const,
    organizationId: opts.organizationId,
    projectId: opts.projectId,
    taskIdentifier: "my-task",
    payload: "{}",
    payloadType: "application/json",
    traceContext: {},
    traceId: `trace_${opts.id}`,
    spanId: `span_${opts.id}`,
    queue: "task/my-task",
    isTest: false,
    taskEventStore: "taskEvent",
    depth: 0,
  };
}

describe("RoutingRunStore.findRunsByIds — grouped, residency-partitioned read of a run id set", () => {
  heteroRunOpsPostgresTest(
    "returns all N rows with a CONSTANT number of grouped findMany calls (never per-id findFirst)",
    async ({ prisma14, prisma17 }) => {
      const legacyCounting = countingClient(prisma14);
      const newCounting = countingClient(prisma17);

      const legacyStore = new PostgresRunStore({
        prisma: legacyCounting.client,
        readOnlyPrisma: legacyCounting.client,
        schemaVariant: "legacy",
      });
      const newStore = new PostgresRunStore({
        prisma: newCounting.client as never,
        readOnlyPrisma: newCounting.client as never,
        schemaVariant: "dedicated",
      });
      const router = new RoutingRunStore({ new: newStore, legacy: legacyStore });

      // Seed 2 LEGACY-resident (cuid) runs + 2 NEW-resident (run-ops id) runs — ids spread across
      // both stores.
      const legEnv = await seedEnvironmentLegacy(prisma14, "grp_leg");
      const newEnv = seedEnvironmentDedicated("grp_new");

      const legacyIds = [`run_${CUID_25(1)}`, `run_${CUID_25(2)}`];
      const newIds = [`run_${NEW_ID_26(1)}`, `run_${NEW_ID_26(2)}`];

      for (const [i, id] of legacyIds.entries()) {
        await prisma14.taskRun.create({
          data: taskRunData({
            id,
            friendlyId: `run_grp_leg_${i}`,
            organizationId: legEnv.organization.id,
            projectId: legEnv.project.id,
            runtimeEnvironmentId: legEnv.environment.id,
          }),
        });
      }
      for (const [i, id] of newIds.entries()) {
        await prisma17.taskRun.create({
          data: taskRunData({
            id,
            friendlyId: `run_grp_new_${i}`,
            organizationId: newEnv.organization.id,
            projectId: newEnv.project.id,
            runtimeEnvironmentId: newEnv.environment.id,
          }),
        });
      }

      const allIds = [...legacyIds, ...newIds];

      // Reset counters after seeding (seeding uses `prisma.taskRun.create`, not find*).
      legacyCounting.counts.findMany = 0;
      legacyCounting.counts.findFirst = 0;
      newCounting.counts.findMany = 0;
      newCounting.counts.findFirst = 0;

      const result = await router.findRunsByIds(allIds, {
        select: { friendlyId: true },
      });

      // All N rows returned, keyed by id.
      expect(result.size).toBe(4);
      for (const id of allIds) {
        expect(result.has(id)).toBe(true);
      }
      expect(result.get(legacyIds[0])?.friendlyId).toBe("run_grp_leg_0");
      expect(result.get(newIds[0])?.friendlyId).toBe("run_grp_new_0");

      // The select omitted `id`; the id we force-inject for keying must not leak into the value.
      expect("id" in (result.get(legacyIds[0]) as object)).toBe(false);
      expect("id" in (result.get(newIds[0]) as object)).toBe(false);

      // GROUPED: exactly one findMany call per store queried (NEW always queried for the whole
      // set; LEGACY queried once more for the misses) — never N per-id findFirst calls.
      expect(newCounting.counts.findMany).toBe(1);
      expect(legacyCounting.counts.findMany).toBe(1);
      expect(newCounting.counts.findFirst).toBe(0);
      expect(legacyCounting.counts.findFirst).toBe(0);
    }
  );
});
