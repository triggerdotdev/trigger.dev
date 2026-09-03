// Routing-topology blip resilience: in split mode a findManyTaskRunWaitpoints with a `waitpoint`
// relation reads the edge on the run's DB, then hydrates the token cross-DB via findManyWaitpoints on
// the OTHER DB. A blip on that token DB during hydration must be retried (the leaf edge read alone is
// not enough). Real two-DB routing store on the pg driver adapter.
import { heteroRunOpsBlipTest } from "@internal/testcontainers";
import type { PrismaClient } from "@trigger.dev/database";
import type { RunOpsPrismaClient } from "@internal/run-ops-database";
import { expect } from "vitest";
import { PostgresRunStore } from "./PostgresRunStore.js";
import { RoutingRunStore } from "./runOpsStore.js";

const RETRY_OPTIONS = { enabled: true, maxAttempts: 15, backoffMinMs: 10, backoffMaxMs: 60 };
const CUID_25 = "c".repeat(25);

function makeRouter(prisma14: PrismaClient, prisma17: RunOpsPrismaClient, onRetry: () => void) {
  const infraRetry = { options: RETRY_OPTIONS, onRetry };
  const newStore = new PostgresRunStore({
    prisma: prisma17 as never,
    readOnlyPrisma: prisma17 as never,
    schemaVariant: "dedicated",
    infraRetry,
  });
  const legacyStore = new PostgresRunStore({
    prisma: prisma14,
    readOnlyPrisma: prisma14,
    schemaVariant: "legacy",
    infraRetry,
  });
  return new RoutingRunStore({ new: newStore, legacy: legacyStore });
}

heteroRunOpsBlipTest(
  "cross-DB waitpoint hydration recovers from a mid-statement blip on the token DB",
  { timeout: 120_000 },
  async ({ prisma14, prisma17, blip17 }) => {
    const suffix = CUID_25.slice(-10);
    const org = await prisma14.organization.create({
      data: { title: `Org ${suffix}`, slug: `org-${suffix}` },
    });
    const project = await prisma14.project.create({
      data: {
        name: `Project ${suffix}`,
        slug: `project-${suffix}`,
        externalRef: `proj_${suffix}`,
        organizationId: org.id,
      },
    });
    const environment = await prisma14.runtimeEnvironment.create({
      data: {
        type: "PRODUCTION",
        slug: `prod-${suffix}`,
        projectId: project.id,
        organizationId: org.id,
        apiKey: `tr_${suffix}`,
        pkApiKey: `pk_${suffix}`,
        shortcode: `sc_${suffix}`,
      },
    });

    // LEGACY-resident run (cuid id) + its blocking edge, both on prisma14.
    const runId = `run_${CUID_25}`;
    await prisma14.taskRun.create({
      data: {
        id: runId,
        engine: "V2",
        status: "EXECUTING",
        friendlyId: `run_${suffix}`,
        runtimeEnvironmentId: environment.id,
        organizationId: org.id,
        projectId: project.id,
        taskIdentifier: "hydrate-task",
        payload: "{}",
        payloadType: "application/json",
        traceContext: {},
        traceId: `trace_${suffix}`,
        spanId: `span_${suffix}`,
        queue: "task/hydrate-task",
        isTest: false,
        taskEventStore: "taskEvent",
        depth: 0,
      },
    });

    // The blocking token lives on the OTHER DB (NEW / prisma17): a cross-DB block.
    const waitpointId = `waitpoint_${"y".repeat(20)}`;
    await prisma17.waitpoint.create({
      data: {
        id: waitpointId,
        friendlyId: `wp_${suffix}`,
        type: "MANUAL",
        status: "PENDING",
        idempotencyKey: `idem_${suffix}`,
        userProvidedIdempotencyKey: false,
        projectId: project.id,
        environmentId: environment.id,
      },
    });
    // The harness re-creates FKs via `prisma db push`; prod drops the cross-DB waitpoint FK so an
    // edge can point at a token on the other DB. Mirror that so this cross-DB block is representable.
    await prisma14.$executeRawUnsafe(
      `ALTER TABLE "TaskRunWaitpoint" DROP CONSTRAINT IF EXISTS "TaskRunWaitpoint_waitpointId_fkey"`
    );
    await prisma14.taskRunWaitpoint.create({
      data: { taskRunId: runId, waitpointId, projectId: project.id },
    });

    let retries = 0;
    const router = makeRouter(prisma14, prisma17, () => {
      retries++;
    });

    const read = () =>
      router.findManyTaskRunWaitpoints({
        where: { taskRunId: runId },
        select: { id: true, waitpoint: { select: { id: true, status: true } } },
      });

    await read(); // warm both pools

    let caught = 0;
    for (let i = 0; i < 40 && caught < 1; i++) {
      const before = retries;
      const p = read();
      await blip17
        .severDuringNextStatement({ queryContains: "Waitpoint", timeoutMs: 6000, pollMs: 1 })
        .catch(() => {});
      const rows = (await p) as Array<{ waitpoint?: { id?: string } | null }>;
      expect(rows).toHaveLength(1);
      expect(rows[0]?.waitpoint?.id).toBe(waitpointId);
      if (retries > before) caught++;
    }
    expect(caught).toBeGreaterThanOrEqual(1);
  }
);
