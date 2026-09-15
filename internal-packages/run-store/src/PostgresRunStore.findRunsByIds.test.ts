// RED→GREEN: `findRunsByIds` is the grouped replacement for `Promise.all(ids.map(id =>
// findRun(id)))` — it must issue ONE `findMany` for the whole id batch, never a `findFirst`
// per id. `postgresTest` is a REAL PrismaClient over the standard (non-dedicated) schema. The
// counting proxy wraps its `taskRun` delegate to tally `findFirst`/`findMany` calls while
// delegating every call to the real client — the DB still runs the query; this is
// instrumentation, not a mock.

import { postgresTest } from "@internal/testcontainers";
import type { PrismaClient } from "@trigger.dev/database";
import { describe, expect } from "vitest";
import { PostgresRunStore } from "./PostgresRunStore.js";
import type { CreateRunInput } from "./types.js";

type CallCounts = { findMany: number; findFirst: number };

// Wraps the named delegates on a REAL client to tally `findMany`/`findFirst` calls PER delegate,
// delegating every call unchanged to the real client (the DB still runs the query).
function countingClient(
  real: PrismaClient,
  delegateNames: string[]
): { client: PrismaClient; counts: Record<string, CallCounts> } {
  const counts: Record<string, CallCounts> = {};
  for (const name of delegateNames) {
    counts[name] = { findMany: 0, findFirst: 0 };
  }
  const wrapped = new Map(
    delegateNames.map((name) => [
      name,
      new Proxy((real as any)[name], {
        get(target, prop) {
          if (prop === "findMany" || prop === "findFirst") {
            counts[name][prop as "findMany" | "findFirst"]++;
          }
          return (target as any)[prop];
        },
      }),
    ])
  );
  const client = new Proxy(real, {
    get(target, prop) {
      if (typeof prop === "string" && wrapped.has(prop)) {
        return wrapped.get(prop);
      }
      return (target as any)[prop];
    },
  }) as PrismaClient;
  return { client, counts };
}

async function seedEnvironment(prisma: PrismaClient) {
  const organization = await prisma.organization.create({
    data: {
      title: "Test Organization",
      slug: "test-organization-findrunsbyids",
    },
  });

  const project = await prisma.project.create({
    data: {
      name: "Test Project",
      slug: "test-project-findrunsbyids",
      externalRef: "proj_findrunsbyids",
      organizationId: organization.id,
    },
  });

  const environment = await prisma.runtimeEnvironment.create({
    data: {
      type: "DEVELOPMENT",
      slug: "dev",
      projectId: project.id,
      organizationId: organization.id,
      apiKey: "tr_dev_apikey_findrunsbyids",
      pkApiKey: "pk_dev_apikey_findrunsbyids",
      shortcode: "short_code_findrunsbyids",
    },
  });

  return { organization, project, environment };
}

function buildCreateRunInput(params: {
  runId: string;
  friendlyId: string;
  organizationId: string;
  projectId: string;
  runtimeEnvironmentId: string;
}): CreateRunInput {
  return {
    data: {
      id: params.runId,
      engine: "V2",
      status: "PENDING",
      friendlyId: params.friendlyId,
      runtimeEnvironmentId: params.runtimeEnvironmentId,
      environmentType: "DEVELOPMENT",
      organizationId: params.organizationId,
      projectId: params.projectId,
      taskIdentifier: "my-task",
      payload: "{}",
      payloadType: "application/json",
      traceContext: {},
      traceId: `trace_${params.runId}`,
      spanId: `span_${params.runId}`,
      queue: "task/my-task",
      isTest: false,
      taskEventStore: "taskEvent",
      depth: 0,
    },
    snapshot: {
      engine: "V2",
      executionStatus: "RUN_CREATED",
      description: "Run was created",
      runStatus: "PENDING",
      environmentId: params.runtimeEnvironmentId,
      environmentType: "DEVELOPMENT",
      projectId: params.projectId,
      organizationId: params.organizationId,
    },
  };
}

describe("PostgresRunStore.findRunsByIds", () => {
  postgresTest(
    "resolves N ids with ONE grouped findMany, never a findFirst per id",
    async ({ prisma }) => {
      const { organization, project, environment } = await seedEnvironment(prisma);

      const seedStore = new PostgresRunStore({ prisma, readOnlyPrisma: prisma });

      const runId1 = "run_findbyids_1";
      const runId2 = "run_findbyids_2";
      await seedStore.createRun(
        buildCreateRunInput({
          runId: runId1,
          friendlyId: "run_findbyids_1_friendly",
          organizationId: organization.id,
          projectId: project.id,
          runtimeEnvironmentId: environment.id,
        })
      );
      await seedStore.createRun(
        buildCreateRunInput({
          runId: runId2,
          friendlyId: "run_findbyids_2_friendly",
          organizationId: organization.id,
          projectId: project.id,
          runtimeEnvironmentId: environment.id,
        })
      );

      const counting = countingClient(prisma, ["taskRun"]);
      const readStore = new PostgresRunStore({ prisma, readOnlyPrisma: counting.client });

      const byId = await readStore.findRunsByIds([runId1, runId2], {
        select: { friendlyId: true, status: true },
      });

      expect(byId.size).toBe(2);
      expect(byId.get(runId1)?.friendlyId).toBe("run_findbyids_1_friendly");
      expect(byId.get(runId1)?.status).toBe("PENDING");
      expect(byId.get(runId2)?.friendlyId).toBe("run_findbyids_2_friendly");
      expect(byId.get(runId2)?.status).toBe("PENDING");

      // The select omitted `id`; the id we force-inject for keying must not leak into the value
      // (it would otherwise violate the declared payload type and expose an unrequested id).
      expect("id" in (byId.get(runId1) as object)).toBe(false);
      expect("id" in (byId.get(runId2) as object)).toBe(false);

      // GROUPED: one findMany for the WHOLE batch, never one findFirst per id.
      expect(counting.counts.taskRun.findMany).toBe(1);
      expect(counting.counts.taskRun.findFirst).toBe(0);
    }
  );
});
