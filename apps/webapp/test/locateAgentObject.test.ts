// Live Postgres + ClickHouse, no mocks beyond `db.server` (pointed at the container's client) and
// `clickhouseFactoryInstance.server` (pointed at a real `ClickHouse` client against the
// container) — the membership join, friendlyId lookups, and error-fingerprint query are real.
// Org membership itself is no longer this service's concern: a removed member now gets 403 from
// the route builder (`organizationScoped: "tokenOrganization"`), not `{ found: false }` from here
// — see `userActorEnvironmentScopeRouteBuilder.test.ts` for that case.
import type { LocateResult } from "@internal/dashboard-agent-contracts";
import type { PrismaClient } from "@trigger.dev/database";
import { ClickHouse } from "@internal/clickhouse";
import { RunId } from "@trigger.dev/core/v3/isomorphic";
import { containerTest } from "@internal/testcontainers";
import { setTimeout as sleep } from "node:timers/promises";
import { describe, expect, vi } from "vitest";
import {
  agentSlug as slug,
  createQueue,
  createRun,
  seedAgentWorld,
  type AgentWorld,
} from "./helpers/dashboardAgentWorld";

// The raw `@clickhouse/client` SDK type isn't a listed webapp dependency (only `@internal/clickhouse`
// is), so these name just the two shapes this file needs off the container's client and the
// `ClickHouse` wrapper's underlying reader, rather than importing it directly.
type RawInsertClient = {
  insert(args: { table: string; values: unknown[]; format: string }): Promise<unknown>;
};
type RawQueryClient = { query: (...args: unknown[]) => unknown };

vi.setConfig({ testTimeout: 60_000 });

const db = vi.hoisted(() => ({ client: null as unknown as PrismaClient }));

vi.mock("~/db.server", async () => {
  const { Prisma } = await import("@trigger.dev/database");
  return {
    get prisma() {
      return db.client;
    },
    get $replica() {
      return db.client;
    },
    sqlDatabaseSchema: Prisma.sql([`public`]),
  };
});

const chFactory = vi.hoisted(() => ({ getClickhouseForOrganization: vi.fn() }));

vi.mock("~/services/clickhouse/clickhouseFactoryInstance.server", () => ({
  clickhouseFactory: chFactory,
}));

import { locateAgentObject, MAX_LOCATIONS } from "~/services/locateAgentObject.server";

async function createDeployment(
  prisma: PrismaClient,
  projectId: string,
  environmentId: string,
  version: string
) {
  const friendlyId = `deployment_${slug()}`;
  const shortCode = slug();
  await prisma.workerDeployment.create({
    data: {
      friendlyId,
      shortCode,
      contentHash: `hash_${slug()}`,
      status: "BUILDING",
      version,
      projectId,
      environmentId,
    },
  });
  return { friendlyId, shortCode };
}

async function createManyEnvironments(
  prisma: PrismaClient,
  projectId: string,
  organizationId: string,
  count: number
) {
  const rows = Array.from({ length: count }, () => {
    const id = slug();
    return {
      id,
      slug: "prod",
      type: "PRODUCTION" as const,
      projectId,
      organizationId,
      apiKey: `tr_${id}`,
      pkApiKey: `pk_${id}`,
      shortcode: id,
    };
  });
  await prisma.runtimeEnvironment.createMany({ data: rows });
  return rows.map((row) => row.id);
}

async function createManyQueues(
  prisma: PrismaClient,
  projectId: string,
  environmentIds: string[],
  name: string
) {
  await prisma.taskQueue.createMany({
    data: environmentIds.map((environmentId) => ({
      friendlyId: `queue_${slug()}`,
      name,
      projectId,
      runtimeEnvironmentId: environmentId,
    })),
  });
}

function chDateTime(date: Date) {
  return date.toISOString().replace("T", " ").replace("Z", "").slice(0, 23);
}

function failedRunRow(
  organizationId: string,
  projectId: string,
  environmentId: string,
  fingerprint: string,
  taskIdentifier: string
) {
  const now = chDateTime(new Date());
  const runId = `r_${slug()}`;
  return {
    environment_id: environmentId,
    organization_id: organizationId,
    project_id: projectId,
    run_id: runId,
    friendly_id: `run_${runId}`,
    status: "COMPLETED_WITH_ERRORS",
    environment_type: "DEVELOPMENT",
    engine: "V2",
    task_identifier: taskIdentifier,
    created_at: now,
    updated_at: now,
    error: { data: { type: "Boom", message: "boom happened", stack: "at x (a.ts:1:1)" } },
    error_fingerprint: fingerprint,
    task_version: "20260101.1",
    _version: Date.now().toString(),
    _is_deleted: 0,
  };
}

/** Seeds one failed run straight into `task_runs_v2`; the `errors_v1` MV populates from it. */
async function insertFailedRun(
  clickhouseClient: RawInsertClient,
  organizationId: string,
  projectId: string,
  environmentId: string,
  fingerprint: string,
  taskIdentifier = "my-task"
) {
  await clickhouseClient.insert({
    table: "trigger_dev.task_runs_v2",
    values: [failedRunRow(organizationId, projectId, environmentId, fingerprint, taskIdentifier)],
    format: "JSONEachRow",
  });
}

/** Seeds `count` distinct (environment, task) pairs for one fingerprint in a single batch insert. */
async function insertManyFailedRuns(
  clickhouseClient: RawInsertClient,
  organizationId: string,
  projectId: string,
  environmentId: string,
  fingerprint: string,
  count: number
) {
  const values = Array.from({ length: count }, (_, i) =>
    failedRunRow(organizationId, projectId, environmentId, fingerprint, `task-${i}`)
  );
  await clickhouseClient.insert({
    table: "trigger_dev.task_runs_v2",
    values,
    format: "JSONEachRow",
  });
}

async function waitForLocated(
  kind: "run" | "deployment" | "error",
  id: string,
  actor: { userId: string; organizationId: string },
  wantScopes: number,
  opts?: { maxExcludedDevEnvironments?: number }
): Promise<LocateResult> {
  let last: LocateResult = { found: false };
  for (let attempt = 0; attempt < 20; attempt++) {
    last = await locateAgentObject(kind, id, actor, opts);
    if (last.found && last.scopes.length >= wantScopes) return last;
    await sleep(250);
  }
  return last;
}

/** Every non-error case: fresh world seeded, `db.client` wired, nothing else to repeat. */
function locateTest(
  name: string,
  fn: (ctx: { prisma: PrismaClient; w: AgentWorld }) => Promise<void>
) {
  containerTest(name, async ({ prisma }) => {
    db.client = prisma;
    await fn({ prisma, w: await seedAgentWorld(prisma) });
  });
}

type ErrorCtx = {
  prisma: PrismaClient;
  w: AgentWorld;
  clickhouseClient: RawInsertClient;
  clickhouse: ClickHouse;
};

/** Same, plus a real `ClickHouse` client wired into the mocked factory for the error kind. */
function errorLocateTest(name: string, fn: (ctx: ErrorCtx) => Promise<void>) {
  containerTest(name, async ({ prisma, clickhouseContainer, clickhouseClient }) => {
    db.client = prisma;
    const clickhouse = new ClickHouse({ url: clickhouseContainer.getConnectionUrl() });
    chFactory.getClickhouseForOrganization.mockResolvedValue(clickhouse);
    await fn({ prisma, w: await seedAgentWorld(prisma), clickhouseClient, clickhouse });
  });
}

describe("locateAgentObject", () => {
  // Each of these is a distinct place a run can be found: a sibling project, the actor's own dev
  // environment, a preview branch (reported under its parent's canonical name plus the branch),
  // and staging (reported by its canonical name, not its dashboard slug "stg").
  const runLocations: Array<{
    name: string;
    project: (w: AgentWorld) => AgentWorld["p1"];
    environment: (w: AgentWorld) => { id: string };
    environmentName: string;
    branch?: string;
  }> = [
    {
      name: "finds a run in a sibling project of the same organization",
      project: (w) => w.p2,
      environment: (w) => w.p2Prod,
      environmentName: "prod",
    },
    {
      name: "finds a run in the actor's own dev environment",
      project: (w) => w.p1,
      environment: (w) => w.p1Dev,
      environmentName: "dev",
    },
    {
      name: "reports a preview-branch run under its parent environment's canonical name",
      project: (w) => w.p2,
      environment: (w) => w.p2Branch,
      environmentName: "preview",
      branch: "feat/a",
    },
    {
      name: 'reports staging\'s canonical name, not its dashboard slug ("stg")',
      project: (w) => w.p1,
      environment: (w) => w.p1Staging,
      environmentName: "staging",
    },
  ];

  for (const location of runLocations) {
    locateTest(location.name, async ({ prisma, w }) => {
      const project = location.project(w);
      const environment = location.environment(w);
      const friendlyId = await createRun(prisma, project.id, environment.id);

      expect(await locateAgentObject("run", friendlyId, w.actor)).toEqual({
        found: true,
        kind: "run",
        id: friendlyId,
        scopes: [
          {
            projectRef: project.externalRef,
            environmentName: location.environmentName,
            environmentId: environment.id,
            ...(location.branch ? { branch: location.branch } : {}),
          },
        ],
      });
    });
  }

  locateTest(
    "finds a deployment by its friendlyId, carrying version and shortCode for get_deploy",
    async ({ prisma, w }) => {
      const { friendlyId, shortCode } = await createDeployment(
        prisma,
        w.p1.id,
        w.p1Prod.id,
        "20260101.1"
      );

      expect(await locateAgentObject("deployment", friendlyId, w.actor)).toEqual({
        found: true,
        kind: "deployment",
        id: friendlyId,
        scopes: [
          {
            projectRef: w.p1.externalRef,
            environmentName: "prod",
            environmentId: w.p1Prod.id,
            version: "20260101.1",
            shortCode,
          },
        ],
      });
    }
  );

  // Each of these is its own gate: the organization boundary, another member's private dev
  // environment, an archived environment, and a soft-deleted project.
  const unreachable: Array<[string, (prisma: PrismaClient, w: AgentWorld) => Promise<string>]> = [
    ["another organization", (prisma, w) => createRun(prisma, w.p3.id, w.p3Prod.id)],
    ["another member's dev environment", (prisma, w) => createRun(prisma, w.p2.id, w.p2Dev.id)],
    ["an archived environment", (prisma, w) => createRun(prisma, w.p2.id, w.p2Archived.id)],
    ["a deleted project", (prisma, w) => createRun(prisma, w.deletedProject.id, w.deletedProd.id)],
  ];

  for (const [scope, seedRun] of unreachable) {
    locateTest(`does not find a run whose only scope is ${scope}`, async ({ prisma, w }) => {
      const friendlyId = await seedRun(prisma, w);
      expect(await locateAgentObject("run", friendlyId, w.actor)).toEqual({ found: false });
    });
  }

  locateTest("does not find a run that doesn't exist", async ({ w }) => {
    const result = await locateAgentObject("run", RunId.generate().friendlyId, w.actor);
    expect(result).toEqual({ found: false });
  });

  locateTest(
    "rejects a deployment looked up by version rather than friendlyId",
    async ({ prisma, w }) => {
      await createDeployment(prisma, w.p1.id, w.p1Prod.id, "20260101.1");
      expect(await locateAgentObject("deployment", "20260101.1", w.actor)).toEqual({
        found: false,
      });
    }
  );

  locateTest(
    "does not find, rather than throw, for an id ErrorId.toId can't parse",
    async ({ w }) => {
      // `error_a_b` has more than one underscore — `ErrorId.toId`'s `fromFriendlyId` throws on that
      // shape. The route admits it (any non-empty string); this must resolve, not 500.
      expect(await locateAgentObject("error", "error_a_b", w.actor)).toEqual({ found: false });
    }
  );

  locateTest(
    "reports unavailable, not found:false, when the warehouse query itself fails",
    async ({ w }) => {
      // A real client pointed at a closed port — a genuine connection failure, not a stub of
      // query results. A failed lookup is not evidence the fingerprint doesn't exist.
      const brokenClickhouse = new ClickHouse({
        url: "http://127.0.0.1:1",
        requestTimeoutMs: 1_000,
      });
      chFactory.getClickhouseForOrganization.mockResolvedValue(brokenClickhouse);

      const result = await locateAgentObject("error", `fp_${slug()}`, w.actor);

      expect(result).toEqual({ found: false, unavailable: true });
    }
  );

  locateTest(
    "reports unavailable, not a thrown error, when acquiring the warehouse client itself fails",
    async ({ w }) => {
      chFactory.getClickhouseForOrganization.mockRejectedValue(new Error("factory unavailable"));

      const result = await locateAgentObject("error", `fp_${slug()}`, w.actor);

      expect(result).toEqual({ found: false, unavailable: true });
    }
  );

  errorLocateTest(
    "finds an untouched error fingerprint in two environments via one ClickHouse query, addressed by its error_… id",
    async ({ w, clickhouseClient, clickhouse }) => {
      // A real fingerprint has no underscore, so `error_<fingerprint>` round-trips cleanly. No
      // `ErrorGroupState` row is ever created — this group has never been resolved/ignored.
      const fingerprint = slug();
      await insertFailedRun(clickhouseClient, w.orgA.id, w.p1.id, w.p1Prod.id, fingerprint);
      await insertFailedRun(clickhouseClient, w.orgA.id, w.p2.id, w.p2Prod.id, fingerprint);

      await waitForLocated("error", fingerprint, w.actor, 2);

      // Exactly one ClickHouse round trip per lookup — never one per environment in the org.
      // `reader.query(...)` is a factory called once per builder just by accessing `.errors`
      // (before any `.execute()`), so the network call itself is the signal: spy one level
      // down, on the underlying `@clickhouse/client` instance's `query`.
      const rawClient = (clickhouse.reader as unknown as { client: RawQueryClient }).client;
      const querySpy = vi.spyOn(rawClient, "query");
      const result = await locateAgentObject("error", `error_${fingerprint}`, w.actor);
      expect(querySpy).toHaveBeenCalledTimes(1);

      expect(result.found).toBe(true);
      if (!result.found) throw new Error("expected found");
      expect(result.id).toBe(`error_${fingerprint}`);
      expect(result.scopes.map((s) => s.environmentId).sort()).toEqual(
        [w.p1Prod.id, w.p2Prod.id].sort()
      );
      for (const scope of result.scopes) {
        expect(scope.taskIdentifier).toBe("my-task");
      }
    }
  );

  errorLocateTest(
    "finds an error fingerprint spanning two task identifiers in one environment",
    async ({ w, clickhouseClient: ch }) => {
      const fingerprint = `fp_${slug()}`;
      const { id: org } = w.orgA;
      const { id: proj } = w.p1;
      const { id: env } = w.p1Prod;
      await insertFailedRun(ch, org, proj, env, fingerprint, "task-a");
      await insertFailedRun(ch, org, proj, env, fingerprint, "task-b");

      const result = await waitForLocated("error", fingerprint, w.actor, 2);

      expect(result.found).toBe(true);
      if (!result.found) throw new Error("expected found");
      expect(result.scopes.every((s) => s.environmentId === w.p1Prod.id)).toBe(true);
      expect(result.scopes.map((s) => s.taskIdentifier).sort()).toEqual(["task-a", "task-b"]);
    }
  );

  errorLocateTest(
    "does not find an error fingerprint that only occurred in another organization",
    async ({ w, clickhouseClient }) => {
      const fingerprint = `fp_${slug()}`;
      await insertFailedRun(clickhouseClient, w.orgB.id, w.p3.id, w.p3Prod.id, fingerprint);

      // No polling for a positive: give the MV a moment, then assert the org boundary holds.
      await sleep(1_000);
      expect(await locateAgentObject("error", fingerprint, w.actor)).toEqual({ found: false });
    }
  );

  errorLocateTest(
    "finds an error fingerprint in the actor's own dev environment and prod as two scopes",
    async ({ w, clickhouseClient }) => {
      const fingerprint = `fp_${slug()}`;
      await insertFailedRun(clickhouseClient, w.orgA.id, w.p1.id, w.p1Prod.id, fingerprint);
      await insertFailedRun(clickhouseClient, w.orgA.id, w.p1.id, w.p1Dev.id, fingerprint);

      const result = await waitForLocated("error", fingerprint, w.actor, 2);

      expect(result.found).toBe(true);
      if (!result.found) throw new Error("expected found");
      expect(result.scopes.map((s) => s.environmentId).sort()).toEqual(
        [w.p1Prod.id, w.p1Dev.id].sort()
      );
    }
  );

  /**
   * Each of these leaves exactly one visible scope for a fingerprint that also occurred somewhere
   * the actor may not see; they differ only in why the other location is hidden, and in whether
   * the answer has to be flagged as truncated.
   */
  const oneVisibleScope: Array<{
    name: string;
    seed: (ctx: ErrorCtx, fingerprint: string) => Promise<void>;
    visible: (w: AgentWorld) => string;
    opts?: { maxExcludedDevEnvironments?: number };
    truncated?: true;
  }> = [
    {
      name: "drops another member's dev environment from an error's scopes, keeping prod",
      seed: async ({ w, clickhouseClient: ch }, fp) => {
        await insertFailedRun(ch, w.orgA.id, w.p2.id, w.p2Prod.id, fp);
        await insertFailedRun(ch, w.orgA.id, w.p2.id, w.p2Dev.id, fp);
      },
      visible: (w) => w.p2Prod.id,
    },
    {
      name: "keeps live prod but drops an archived environment, without flagging truncation",
      seed: async ({ w, clickhouseClient: ch }, fp) => {
        await insertFailedRun(ch, w.orgA.id, w.p1.id, w.p1Prod.id, fp);
        await insertFailedRun(ch, w.orgA.id, w.p2.id, w.p2Archived.id, fp);
      },
      visible: (w) => w.p1Prod.id,
    },
    {
      name: "excludes a departed member's dev environment (orgMemberId nulled, not reassigned)",
      seed: async ({ w, prisma, clickhouseClient: ch }, fp) => {
        await insertFailedRun(ch, w.orgA.id, w.p2.id, w.p2Prod.id, fp);
        await insertFailedRun(ch, w.orgA.id, w.p2.id, w.p2Dev.id, fp);
        // The other member leaves the org — their dev env's `orgMemberId` goes null (SetNull), it
        // is never reassigned to anyone, and it must stay hidden from the actor regardless.
        await prisma.orgMember.deleteMany({
          where: { userId: w.otherUser.id, organizationId: w.orgA.id },
        });
      },
      visible: (w) => w.p2Prod.id,
    },
    {
      name: "never discloses a hidden environment when the exclusion list itself overflows",
      // A cap of 0 forces the ClickHouse exclusion to overflow on the org's one other-member dev
      // environment, so the `NOT IN` predicate is skipped entirely — Postgres must still keep the
      // hidden environment out of the response, and the overflow itself must be flagged.
      seed: async ({ w, clickhouseClient: ch }, fp) => {
        await insertFailedRun(ch, w.orgA.id, w.p2.id, w.p2Dev.id, fp);
        await insertFailedRun(ch, w.orgA.id, w.p2.id, w.p2Prod.id, fp);
      },
      visible: (w) => w.p2Prod.id,
      opts: { maxExcludedDevEnvironments: 0 },
      truncated: true,
    },
    {
      name: "does not miscount another member's overflowing dev environment as truncation",
      // More than the cap in another member's private dev environment, ordered before the
      // visible prod row (`environment_id, task_identifier` ASC) if it weren't excluded inside
      // the query — the cap must apply to visible rows only, not to this hidden overflow.
      seed: async ({ w, clickhouseClient: ch }, fp) => {
        await insertManyFailedRuns(ch, w.orgA.id, w.p2.id, w.p2Dev.id, fp, MAX_LOCATIONS + 1);
        await insertFailedRun(ch, w.orgA.id, w.p2.id, w.p2Prod.id, fp);
      },
      visible: (w) => w.p2Prod.id,
    },
  ];

  for (const oneScope of oneVisibleScope) {
    errorLocateTest(oneScope.name, async (ctx) => {
      const fingerprint = `fp_${slug()}`;
      await oneScope.seed(ctx, fingerprint);

      const result = await waitForLocated("error", fingerprint, ctx.w.actor, 1, oneScope.opts);

      expect(result.found).toBe(true);
      if (!result.found) throw new Error("expected found");
      expect(result.scopes).toHaveLength(1);
      expect(result.scopes[0]!.environmentId).toBe(oneScope.visible(ctx.w));
      if (oneScope.truncated) {
        expect(result.truncated).toBe(true);
      } else {
        expect(result.truncated).toBeFalsy();
      }
    });
  }

  errorLocateTest(
    "flags truncated on a bare not-found when the one visible row sorts beyond the cap",
    async ({ w, clickhouseClient }) => {
      const fingerprint = `fp_${slug()}`;
      // A cap of 0 also skips the ClickHouse exclusion (as above), but this time there's enough
      // hidden-environment noise ahead of the single visible row (same `environment_id, …` sort)
      // to fill the fetch limit entirely — the visible row is never even fetched. The answer must
      // still be flagged, not a confident "doesn't exist".
      await insertManyFailedRuns(
        clickhouseClient,
        w.orgA.id,
        w.p2.id,
        w.p2Dev.id,
        fingerprint,
        MAX_LOCATIONS + 1
      );
      await insertFailedRun(clickhouseClient, w.orgA.id, w.p2.id, w.p2Prod.id, fingerprint);

      const opts = { maxExcludedDevEnvironments: 0 };
      let result = await locateAgentObject("error", fingerprint, w.actor, opts);
      for (let attempt = 0; attempt < 20; attempt++) {
        if (result.found === false && result.truncated === true) break;
        await sleep(250);
        result = await locateAgentObject("error", fingerprint, w.actor, opts);
      }

      expect(result).toEqual({ found: false, truncated: true });
    }
  );

  errorLocateTest(
    "flags truncated when a fingerprint's visible locations exceed the cap",
    async ({ w, clickhouseClient }) => {
      const fingerprint = `fp_${slug()}`;
      // One past the cap, all in one visible environment.
      await insertManyFailedRuns(
        clickhouseClient,
        w.orgA.id,
        w.p1.id,
        w.p1Prod.id,
        fingerprint,
        MAX_LOCATIONS + 1
      );

      const result = await waitForLocated("error", fingerprint, w.actor, MAX_LOCATIONS);

      expect(result.found).toBe(true);
      if (!result.found) throw new Error("expected found");
      expect(result.truncated).toBe(true);
      expect(result.scopes.length).toBeGreaterThan(0);
      expect(result.scopes.every((s) => s.environmentId === w.p1Prod.id)).toBe(true);
    }
  );

  locateTest("finds a queue by name in one environment", async ({ prisma, w }) => {
    const name = `q_${slug()}`;
    await createQueue(prisma, w.p1.id, w.p1Prod.id, name);

    expect(await locateAgentObject("queue", name, w.actor)).toEqual({
      found: true,
      kind: "queue",
      id: name,
      scopes: [
        {
          projectRef: w.p1.externalRef,
          environmentName: "prod",
          environmentId: w.p1Prod.id,
          queueName: name,
          queueType: "custom",
        },
      ],
    });
  });

  locateTest("finds a queue in the actor's own dev environment", async ({ prisma, w }) => {
    const name = `q_${slug()}`;
    await createQueue(prisma, w.p1.id, w.p1Dev.id, name);

    expect(await locateAgentObject("queue", name, w.actor)).toEqual({
      found: true,
      kind: "queue",
      id: name,
      scopes: [
        {
          projectRef: w.p1.externalRef,
          environmentName: "dev",
          environmentId: w.p1Dev.id,
          queueName: name,
          queueType: "custom",
        },
      ],
    });
  });

  locateTest("finds the same queue name in two projects as two scopes", async ({ prisma, w }) => {
    const name = `q_${slug()}`;
    await createQueue(prisma, w.p1.id, w.p1Prod.id, name);
    await createQueue(prisma, w.p2.id, w.p2Prod.id, name);

    const result = await locateAgentObject("queue", name, w.actor);

    expect(result.found).toBe(true);
    if (!result.found) throw new Error("expected found");
    expect(result.scopes.map((s) => s.environmentId).sort()).toEqual(
      [w.p1Prod.id, w.p2Prod.id].sort()
    );
  });

  locateTest(
    "drops another member's dev environment from a queue's scopes, keeping prod",
    async ({ prisma, w }) => {
      const name = `q_${slug()}`;
      await createQueue(prisma, w.p2.id, w.p2Dev.id, name);
      await createQueue(prisma, w.p2.id, w.p2Prod.id, name);

      const result = await locateAgentObject("queue", name, w.actor);

      expect(result.found).toBe(true);
      if (!result.found) throw new Error("expected found");
      expect(result.scopes).toHaveLength(1);
      expect(result.scopes[0]!.environmentId).toBe(w.p2Prod.id);
    }
  );

  locateTest(
    "does not find a queue that only exists in another organization",
    async ({ prisma, w }) => {
      const name = `q_${slug()}`;
      await createQueue(prisma, w.p3.id, w.p3Prod.id, name);

      expect(await locateAgentObject("queue", name, w.actor)).toEqual({ found: false });
    }
  );

  locateTest(
    "reports queueType task for a task/-prefixed queue, addressed by its bare name",
    async ({ prisma, w }) => {
      const name = `q_${slug()}`;
      await createQueue(prisma, w.p1.id, w.p1Prod.id, `task/${name}`);

      const result = await locateAgentObject("queue", name, w.actor);

      expect(result.found).toBe(true);
      if (!result.found) throw new Error("expected found");
      expect(result.scopes).toHaveLength(1);
      expect(result.scopes[0]).toMatchObject({ queueName: `task/${name}`, queueType: "task" });
    }
  );

  locateTest(
    "addressed by its prefixed name, matches only the task queue",
    async ({ prisma, w }) => {
      const name = `q_${slug()}`;
      await createQueue(prisma, w.p1.id, w.p1Prod.id, `task/${name}`);
      await createQueue(prisma, w.p1.id, w.p1Dev.id, name);

      const result = await locateAgentObject("queue", `task/${name}`, w.actor);

      expect(result.found).toBe(true);
      if (!result.found) throw new Error("expected found");
      expect(result.scopes).toHaveLength(1);
      expect(result.scopes[0]).toMatchObject({
        environmentId: w.p1Prod.id,
        queueName: `task/${name}`,
        queueType: "task",
      });
    }
  );

  locateTest(
    "addressed by its prefixed name, does not reach a doubly-prefixed queue",
    async ({ prisma, w }) => {
      // `task/{name}` is the task queue of task `{name}`, not of a task called `task/{name}`.
      const name = `q_${slug()}`;
      await createQueue(prisma, w.p1.id, w.p1Prod.id, `task/${name}`);
      await createQueue(prisma, w.p1.id, w.p1Dev.id, `task/task/${name}`);

      const result = await locateAgentObject("queue", `task/${name}`, w.actor);

      expect(result.found).toBe(true);
      if (!result.found) throw new Error("expected found");
      expect(result.scopes.map((s) => s.queueName)).toEqual([`task/${name}`]);
    }
  );

  locateTest("addressed by its bare name, matches both spellings", async ({ prisma, w }) => {
    const name = `q_${slug()}`;
    await createQueue(prisma, w.p1.id, w.p1Prod.id, `task/${name}`);
    await createQueue(prisma, w.p1.id, w.p1Dev.id, name);

    const result = await locateAgentObject("queue", name, w.actor);

    expect(result.found).toBe(true);
    if (!result.found) throw new Error("expected found");
    expect(result.scopes.map((s) => s.queueName).sort()).toEqual([name, `task/${name}`].sort());
  });

  locateTest(
    "flags truncated when a queue name's visible locations exceed the cap",
    async ({ prisma, w }) => {
      const name = `q_${slug()}`;
      const environmentIds = await createManyEnvironments(
        prisma,
        w.p1.id,
        w.orgA.id,
        MAX_LOCATIONS + 1
      );
      await createManyQueues(prisma, w.p1.id, environmentIds, name);

      const result = await locateAgentObject("queue", name, w.actor);

      expect(result.found).toBe(true);
      if (!result.found) throw new Error("expected found");
      expect(result.truncated).toBe(true);
      expect(result.scopes).toHaveLength(MAX_LOCATIONS);
    }
  );

  locateTest("does not find a queue in an archived environment", async ({ prisma, w }) => {
    const name = `q_${slug()}`;
    await createQueue(prisma, w.p2.id, w.p2Archived.id, name);

    expect(await locateAgentObject("queue", name, w.actor)).toEqual({ found: false });
  });

  locateTest("does not find a queue under a soft-deleted project", async ({ prisma, w }) => {
    const name = `q_${slug()}`;
    await createQueue(prisma, w.deletedProject.id, w.deletedProd.id, name);

    expect(await locateAgentObject("queue", name, w.actor)).toEqual({ found: false });
  });

  locateTest(
    "reports unavailable, not found:false, when the visible-environment lookup itself overflows",
    async ({ prisma, w }) => {
      const name = `q_${slug()}`;
      await createQueue(prisma, w.p1.id, w.p1Prod.id, name);

      const result = await locateAgentObject("queue", name, w.actor, {
        maxVisibleEnvironments: 0,
      });

      expect(result).toEqual({ found: false, unavailable: true });
    }
  );
});
