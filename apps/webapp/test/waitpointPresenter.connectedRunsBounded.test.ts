// RED->GREEN guard: WaitpointPresenter connected-run gather must BOUND the fetch of a waitpoint's
// connected-run ids, not just the number displayed. A "displayed count <= 5" assertion would
// false-green (the take:5 on the run resolve already bounds the DISPLAY). Instead this captures the
// real `taskRun.findMany` call args via a Proxy over a REAL testcontainer Postgres client (no mocks)
// and asserts the IN-list is capped at the scan limit (danglers over-read), never unbounded.
//
// Exercises the dedicated-schema (Prisma `waitpointRunConnection`) branch: waitpoint + more than the
// scan-limit connected runs seeded on the NEW dedicated run-ops client (RunOpsPrismaClient, prisma17).
import { describe, expect, vi } from "vitest";

const legacyReplicaHolder = vi.hoisted(() => ({ client: undefined as any }));
const newClientHolder = vi.hoisted(() => ({ client: undefined as any }));

vi.mock("~/db.server", async () => {
  const { Prisma } = await import("@trigger.dev/database");
  const lazyProxy = (holder: { client: any }, label: string) =>
    new Proxy(
      {},
      {
        get(_t, prop) {
          if (!holder.client) {
            throw new Error(`${label} not set for this test`);
          }
          return holder.client[prop];
        },
      }
    );
  const replicaProxy = lazyProxy(legacyReplicaHolder, "legacyReplicaHolder.client");
  return {
    prisma: replicaProxy,
    $replica: replicaProxy,
    runOpsNewPrisma: lazyProxy(newClientHolder, "newClientHolder.client"),
    runOpsNewReplica: lazyProxy(newClientHolder, "newClientHolder.client"),
    runOpsLegacyPrisma: replicaProxy,
    runOpsLegacyReplica: replicaProxy,
    sqlDatabaseSchema: Prisma.sql([`public`]),
    DATABASE_SCHEMA: "public",
  };
});

vi.mock("~/services/clickhouse/clickhouseFactoryInstance.server", () => ({
  clickhouseFactory: {
    getClickhouseForOrganization: async () => ({}),
  },
}));

// Echo the runId set back as runs so the presenter's final CH hydrate never runs for real -- the
// thing under test is the connected-run-id GATHER (the taskRun.findMany args), not this step.
vi.mock("~/presenters/v3/NextRunListPresenter.server", () => ({
  NextRunListPresenter: class {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    constructor(..._args: unknown[]) {}
    async call(_organizationId: string, _environmentId: string, opts: { runId?: string[] }) {
      return {
        runs: (opts.runId ?? []).map((friendlyId) => ({
          friendlyId,
          taskIdentifier: "echoed",
        })),
      };
    }
  },
}));

import { heteroRunOpsPostgresTest } from "@internal/testcontainers";
import type { PrismaClient } from "@trigger.dev/database";
import type { RunOpsPrismaClient } from "@internal/run-ops-database";
import {
  CONNECTED_RUNS_CONNECTION_SCAN_LIMIT,
  WaitpointPresenter,
} from "~/presenters/v3/WaitpointPresenter.server";

vi.setConfig({ testTimeout: 90_000 });

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
      type: "DEVELOPMENT",
      projectId: project.id,
      organizationId: organization.id,
      apiKey: `tr_dev_${slug}`,
      pkApiKey: `pk_dev_${slug}`,
      shortcode: `sc-${slug}`,
    },
  });
  return {
    organizationId: organization.id,
    projectId: project.id,
    environmentId: runtimeEnvironment.id,
  };
}

async function seedWaitpoint(
  prisma: PrismaClient | RunOpsPrismaClient,
  ctx: SeedContext,
  friendlyId: string
) {
  return (prisma as PrismaClient).waitpoint.create({
    data: {
      friendlyId,
      type: "MANUAL",
      status: "COMPLETED",
      idempotencyKey: `idem-${friendlyId}`,
      userProvidedIdempotencyKey: false,
      outputType: "application/json",
      outputIsError: false,
      completedAt: new Date(),
      tags: [],
      projectId: ctx.projectId,
      environmentId: ctx.environmentId,
    },
  });
}

async function seedRun(
  prisma: PrismaClient | RunOpsPrismaClient,
  ctx: SeedContext,
  friendlyId: string
) {
  return (prisma as PrismaClient).taskRun.create({
    data: {
      friendlyId,
      taskIdentifier: "my-task",
      status: "PENDING",
      payload: JSON.stringify({ foo: friendlyId }),
      payloadType: "application/json",
      traceId: friendlyId,
      spanId: friendlyId,
      queue: "test",
      runtimeEnvironmentId: ctx.environmentId,
      projectId: ctx.projectId,
      organizationId: ctx.organizationId,
      environmentType: "DEVELOPMENT",
      engine: "V2",
    },
  });
}

// Wrap the REAL dedicated run-ops client's `taskRun.findMany` to capture the args of every call,
// delegating unchanged to the real client (the DB still runs the query -- pure instrumentation,
// never a mock).
function capturingTaskRunFindMany(real: RunOpsPrismaClient): {
  client: RunOpsPrismaClient;
  calls: { where?: { id?: { in?: string[] } } }[];
} {
  const calls: { where?: { id?: { in?: string[] } } }[] = [];
  const wrappedTaskRun = new Proxy((real as any).taskRun, {
    get(target, prop) {
      if (prop === "findMany") {
        return (...args: any[]) => {
          calls.push(args[0]);
          return (target as any)[prop](...args);
        };
      }
      return (target as any)[prop];
    },
  });
  const client = new Proxy(real as object, {
    get(target, prop) {
      if (prop === "taskRun") {
        return wrappedTaskRun;
      }
      return (target as any)[prop];
    },
  }) as RunOpsPrismaClient;
  return { client, calls };
}

// Seed MORE than the scan limit so the assertion bites: an unbounded gather IN-lists all of them,
// a correctly bounded one caps at CONNECTED_RUNS_CONNECTION_SCAN_LIMIT.
const CONNECTED_RUN_COUNT = CONNECTED_RUNS_CONNECTION_SCAN_LIMIT + 5;

describe("WaitpointPresenter bounds the connected-run-id FETCH", () => {
  heteroRunOpsPostgresTest(
    "a waitpoint with more connections than the scan limit caps the IN-list at the scan limit",
    async ({ prisma14, prisma17 }) => {
      const ctx = await seedParents(prisma14, "bounded");
      const waitpoint = await seedWaitpoint(prisma17, ctx, "waitpoint_bounded");

      const runs = await Promise.all(
        Array.from({ length: CONNECTED_RUN_COUNT }, (_, i) => seedRun(prisma17, ctx, `run_b${i}`))
      );
      for (const run of runs) {
        await prisma17.waitpointRunConnection.create({
          data: { taskRunId: run.id, waitpointId: waitpoint.id },
        });
      }

      legacyReplicaHolder.client = prisma14;
      newClientHolder.client = prisma17;

      const { client: countingPrisma17, calls } = capturingTaskRunFindMany(prisma17);

      const presenter = new WaitpointPresenter(undefined, undefined, {
        splitEnabled: true,
        newClient: countingPrisma17 as unknown as PrismaClient,
        legacyReplica: prisma14,
      });

      await presenter.call({
        friendlyId: waitpoint.friendlyId,
        environmentId: ctx.environmentId,
        projectId: ctx.projectId,
      });

      // The guard: assert the FETCH (the IN-list built from the connected-run-id gather) is
      // bounded, not just the eventual displayed count. An unbounded gather would IN-list every
      // connection row; the dedicated branch over-reads up to CONNECTED_RUNS_CONNECTION_SCAN_LIMIT
      // (25) so a display slot is never lost to a dangler, so the IN-list must be capped at the
      // scan limit -- above the display limit (5), but never unbounded.
      expect(calls.length).toBeGreaterThan(0);
      for (const call of calls) {
        expect(call.where?.id?.in?.length ?? 0).toBeLessThanOrEqual(
          CONNECTED_RUNS_CONNECTION_SCAN_LIMIT
        );
      }
    }
  );
});
