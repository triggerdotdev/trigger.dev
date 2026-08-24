// Property: the CANCEL route resolves a just-created run under replica lag. The real exported `action`
// finds a run present only on the primary (replica frozen "missing", buffer disabled) via the primary
// re-read and cancels it, returning the success redirect rather than "Run not found".
//
// Drives the REAL route `action` (not a direct store call) against a REAL Postgres testcontainer with a
// REAL lagging replica (shared `laggingReplica`, `taskRun` frozen "missing"). Only peripherals are
// mocked: the dashboard auth gate (rbac/session), the downstream CancelTaskRunService, the mollifier
// buffer (disabled), and the toast/redirect formatting. The run read and the found/not-found decision
// run for real.

import { heteroPostgresTest, laggingReplica } from "@internal/testcontainers";
import type { PrismaClient } from "@trigger.dev/database";
import { describe, expect, vi } from "vitest";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

// ---- Holders wired into the mocked module singletons before each action() call. ------------------
// `primaryHolder.client` -> the real container (the writer / owning primary).
// `replicaHolder.client` -> a lagging replica over the SAME container: `taskRun` reads come back empty
//   (row "not replicated yet"), every other model + all writes forward to the real container.
const primaryHolder = vi.hoisted(() => ({ client: undefined as any }));
const replicaHolder = vi.hoisted(() => ({ client: undefined as any }));

// Records every CancelTaskRunService.call(run) so the test can assert the cancel was reached with the
// right run.
const cancelCalls = vi.hoisted(() => ({ runs: [] as any[] }));

// The user the (mocked) dashboard auth resolves to — must match the seeded OrgMember so the route's
// real control-plane membership check (`prisma.project.findFirst({ ... members: { some: { userId }}}`)
// authorizes the cancel.
const AUTH = vi.hoisted(() => ({ userId: "user_cancel_guard" }));

// ~/db.server: point the two proxies the run-store / control-plane singletons read at our holders.
// Never mocks the DB itself — the proxies forward to real testcontainer clients. Run-ops split
// handles are left undefined so runStore.server falls back to the single control-plane store
// (buildRunStore split-off): writer = `prisma`, replica = `$replica`. That is the exact webapp
// single-DB topology this read-your-writes property lives in.
vi.mock("~/db.server", async () => {
  const { Prisma } = await import("@trigger.dev/database");
  const lazyProxy = (holder: { client: any }, label: string) =>
    new Proxy(
      {},
      {
        get(_t, prop) {
          if (!holder.client) throw new Error(`${label} not set for this test`);
          const value = holder.client[prop];
          // The run-store singleton memoizes each Prisma delegate on first access; re-resolve through
          // the holder so it always routes to the current test's client (mirrors the sibling
          // waitpointCallback.controlPlane test's proxy).
          if (value !== null && typeof value === "object") {
            return new Proxy(value, { get: (_d, method) => holder.client[prop][method] });
          }
          return value;
        },
      }
    );
  return {
    prisma: lazyProxy(primaryHolder, "primaryHolder.client"),
    $replica: lazyProxy(replicaHolder, "replicaHolder.client"),
    // Split-off: leaving these undefined makes runStore.server build the single-DB passthrough store.
    runOpsNewPrismaClient: undefined,
    runOpsNewReplicaClient: undefined,
    runOpsLegacyPrisma: undefined,
    runOpsLegacyReplica: undefined,
    sqlDatabaseSchema: Prisma.sql([`public`]),
  };
});

// Dashboard auth gate (peripheral): a passing ability + constant user id. The route's REAL
// control-plane membership check still runs against the seeded OrgMember.
vi.mock("~/services/rbac.server", () => ({
  rbac: {
    authenticateSession: async () => ({
      ok: true,
      user: { id: AUTH.userId, email: "guard@example.com", admin: false },
      ability: { can: () => true, canSuper: () => true },
    }),
  },
}));

// Prevent the remix-auth strategy chain (auth.server validates secrets at module load) from loading
// via dashboardBuilder.server's static `getUserId` import. Auth outcome is owned by the rbac mock.
vi.mock("~/services/session.server", () => ({
  getUserId: async () => undefined,
  requireUserId: async () => AUTH.userId,
}));

// Buffer disabled: getEntry never returns an entry, so the buffer fallback is a clean miss and the
// only thing that can find the run is the run-store read (replica, then the primary re-read).
vi.mock("~/v3/mollifier/mollifierBuffer.server", () => ({
  getMollifierBuffer: () => null,
}));

// Downstream cancel is engine work, not the read under test: record the call and no-op.
vi.mock("~/v3/services/cancelTaskRun.server", () => ({
  CancelTaskRunService: class {
    async call(run: any) {
      cancelCalls.runs.push(run);
    }
  },
}));

// Toast/redirect formatting is not under test; return marker Responses so assertions don't depend on
// SESSION_SECRET / cookie machinery. The success path returns a 302 here; the "Run not found" path
// returns a remix `json(...)` (200) from the real route code, which is how a failure to cancel shows up.
vi.mock("~/models/message.server", () => ({
  redirectWithSuccessMessage: async (path: string, _req: Request, message: string) =>
    new Response(null, { status: 302, headers: { "x-redirect": path, "x-toast": message } }),
  redirectWithErrorMessage: async (path: string, _req: Request, message: string) =>
    new Response(null, { status: 302, headers: { "x-redirect": path, "x-error": message } }),
}));

import { PostgresRunStore } from "@internal/run-store";
import type { CreateRunInput } from "@internal/run-store";
// The REAL route action under test.
import { action } from "~/routes/resources.taskruns.$runParam.cancel";

let seq = 0;

async function seedTenant(prisma: PrismaClient, suffix: string) {
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
  // The user the auth mock resolves to, joined to the org so the route's real membership check passes.
  await prisma.user.create({
    data: {
      id: AUTH.userId,
      email: `guard-${suffix}@example.com`,
      authenticationMethod: "MAGIC_LINK",
    },
  });
  await prisma.orgMember.create({
    data: { userId: AUTH.userId, organizationId: organization.id, role: "ADMIN" },
  });
  return { organization, project, environment };
}

function buildCreateRunInput(p: {
  runId: string;
  friendlyId: string;
  organizationId: string;
  projectId: string;
  runtimeEnvironmentId: string;
}): CreateRunInput {
  return {
    data: {
      id: p.runId,
      engine: "V2",
      status: "PENDING",
      friendlyId: p.friendlyId,
      runtimeEnvironmentId: p.runtimeEnvironmentId,
      environmentType: "DEVELOPMENT",
      organizationId: p.organizationId,
      projectId: p.projectId,
      taskIdentifier: "my-task",
      payload: '{"hello":"world"}',
      payloadType: "application/json",
      context: { foo: "bar" },
      traceContext: { trace: "ctx" },
      traceId: "trace_1",
      spanId: "span_1",
      runTags: [],
      queue: "task/my-task",
      isTest: false,
      taskEventStore: "taskEvent",
      depth: 0,
      createdAt: new Date("2024-01-01T00:00:00.000Z"),
    },
    snapshot: {
      engine: "V2",
      executionStatus: "RUN_CREATED",
      description: "Run was created",
      runStatus: "PENDING",
      environmentId: p.runtimeEnvironmentId,
      environmentType: "DEVELOPMENT",
      projectId: p.projectId,
      organizationId: p.organizationId,
    },
  };
}

function cancelRequest(redirectUrl: string) {
  const body = new URLSearchParams({ redirectUrl }).toString();
  return new Request("http://localhost/resources/taskruns/x/cancel", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
}

describe("cancel route resolves a just-created run under replica lag", () => {
  heteroPostgresTest(
    "cancels a live run whose row has not yet replicated",
    async ({ prisma14 }) => {
      const prisma = prisma14 as unknown as PrismaClient;
      const suffix = `cancel_guard_${seq++}`;

      const seed = await seedTenant(prisma, suffix);

      // Seed the run on the PRIMARY (writer) only. The lagging replica will not see it.
      const runId = `run_${"c".repeat(21)}`; // cuid-shaped -> legacy single store
      const friendlyId = `run_${suffix}`;
      const writerStore = new PostgresRunStore({ prisma, readOnlyPrisma: prisma });
      await writerStore.createRun(
        buildCreateRunInput({
          runId,
          friendlyId,
          organizationId: seed.organization.id,
          projectId: seed.project.id,
          runtimeEnvironmentId: seed.environment.id,
        })
      );

      // A REAL lagging replica over the same container: taskRun reads miss; everything else forwards.
      const replica = laggingReplica(prisma, [{ model: "taskRun", mode: "missing" }]);

      primaryHolder.client = prisma;
      replicaHolder.client = replica.client;

      cancelCalls.runs.length = 0;

      const redirectUrl = "/orgs/x/projects/y/runs";
      const res = await action({
        request: cancelRequest(redirectUrl),
        params: { runParam: friendlyId },
        context: {} as never,
      });

      // The replica WAS consulted (the read-your-writes hazard was really exercised)...
      expect(replica.wasHit("taskRun")).toBe(true);

      // ...and the primary re-read found the run, so the cancel was reached with the right run.
      expect(cancelCalls.runs).toHaveLength(1);
      expect(cancelCalls.runs[0].friendlyId).toBe(friendlyId);
      expect(cancelCalls.runs[0].id).toBe(runId);

      // The action returned the success redirect, NOT the "Run not found" json(200).
      expect(res.status).toBe(302);
      expect(res.headers.get("x-redirect")).toBe(redirectUrl);
      expect(res.headers.get("x-toast")).toBe("Canceled run");

      // Belt-and-braces: the body is not the "Run not found" field-error json.
      const bodyText = await res.clone().text();
      expect(bodyText).not.toContain("Run not found");
    }
  );
});
