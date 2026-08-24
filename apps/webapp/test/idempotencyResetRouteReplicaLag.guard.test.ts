// Property: the idempotency-key RESET route action resolves a live run under replica lag. When the
// replica-first findRun misses a just-created run, the action re-reads the owning primary via
// findRunOnPrimary, reaches ResetIdempotencyKeyService, and returns the "Idempotency key reset
// successfully" toast — never a "Run not found" short-circuit for a run the user can see.
//
// Drives the REAL exported route action against a real split store (heteroRunOpsPostgresTest, two
// Postgres containers) whose owning replica is frozen with the shared lagging-replica primitive. Only
// module seams that inject the store / assert the outcome are mocked (dependency injection at the
// module boundary, not reimplementation — the store classes and findRun/findRunOnPrimary are real):
// runStore (the RoutingRunStore built here), db (the live legacy container the tenant is seeded on),
// session (a fixed userId), and resetIdempotencyKey (a recording stub of the reached service).

import type * as RemixNode from "@remix-run/node";
import { heteroRunOpsPostgresTest, laggingReplica } from "@internal/testcontainers";
import { describe, expect, vi } from "vitest";
import { PostgresRunStore, RoutingRunStore } from "@internal/run-store";
import type { CreateRunInput } from "@internal/run-store";

vi.setConfig({ testTimeout: 60_000 });

// Mutable holders shared with the hoisted vi.mock factories below. The route module is imported
// dynamically inside each test AFTER these are populated, and the mock factories read them lazily via
// getters, so each test injects its own live store + prisma client.
const h = vi.hoisted(() => ({
  runStore: undefined as unknown,
  prisma: undefined as unknown,
  userId: "usr_reset_guard",
  resetCalls: [] as Array<{ idempotencyKey: string; taskIdentifier: string; envId: string }>,
}));

vi.mock("~/services/session.server", () => ({
  requireUserId: vi.fn(async () => h.userId),
}));

vi.mock("~/v3/runStore.server", () => ({
  get runStore() {
    return h.runStore;
  },
}));

vi.mock("~/db.server", () => ({
  get prisma() {
    return h.prisma;
  },
}));

vi.mock("~/v3/services/resetIdempotencyKey.server", () => ({
  ResetIdempotencyKeyService: class {
    async call(idempotencyKey: string, taskIdentifier: string, authenticatedEnv: { id: string }) {
      h.resetCalls.push({ idempotencyKey, taskIdentifier, envId: authenticatedEnv?.id });
      return { id: idempotencyKey };
    }
  },
}));

// Test-safe cookie session (fixed secret, real @remix-run/node storage) so the route's toast
// round-trip is exercised end-to-end without loading app env config (`env.server`/SESSION_SECRET).
vi.mock("~/models/message.server", async () => {
  const { createCookieSessionStorage, json } = (await vi.importActual(
    "@remix-run/node"
  )) as typeof RemixNode;
  const { getSession, commitSession } = createCookieSessionStorage({
    cookie: {
      name: "__message",
      path: "/",
      httpOnly: true,
      sameSite: "lax",
      secrets: ["test-secret"],
    },
  });
  const jsonWith = async (
    data: unknown,
    request: Request,
    message: string,
    type: "success" | "error"
  ) => {
    const session = await getSession(request.headers.get("cookie"));
    session.flash("toastMessage", { message, type, options: { ephemeral: true } });
    return json(data, { headers: { "Set-Cookie": await commitSession(session) } });
  };
  return {
    getSession,
    commitSession,
    jsonWithSuccessMessage: (data: unknown, request: Request, message: string) =>
      jsonWith(data, request, message, "success"),
    jsonWithErrorMessage: (data: unknown, request: Request, message: string) =>
      jsonWith(data, request, message, "error"),
  };
});

const RESET_SELECT = {
  id: true,
  idempotencyKey: true,
  taskIdentifier: true,
  projectId: true,
  runtimeEnvironmentId: true,
} as const;

function buildCreateRunInput(params: {
  runId: string;
  friendlyId: string;
  taskIdentifier: string;
  organizationId: string;
  projectId: string;
  runtimeEnvironmentId: string;
  idempotencyKey: string;
}): CreateRunInput {
  return {
    data: {
      id: params.runId,
      engine: "V2",
      status: "COMPLETED_SUCCESSFULLY",
      friendlyId: params.friendlyId,
      runtimeEnvironmentId: params.runtimeEnvironmentId,
      environmentType: "DEVELOPMENT",
      organizationId: params.organizationId,
      projectId: params.projectId,
      taskIdentifier: params.taskIdentifier,
      idempotencyKey: params.idempotencyKey,
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
      environmentId: params.runtimeEnvironmentId,
      environmentType: "DEVELOPMENT",
      projectId: params.projectId,
      organizationId: params.organizationId,
    },
  } as CreateRunInput;
}

// Decode the flashed toast from the action's Set-Cookie so we assert the user-visible outcome, not an
// internal. Uses the mocked test-safe message.server session above (no env.server / SESSION_SECRET).
async function readToast(
  response: Response
): Promise<{ message: string; type: string } | undefined> {
  const { getSession } = await import("~/models/message.server");
  const setCookie = response.headers.get("Set-Cookie");
  const session = await getSession(setCookie);
  return session.get("toastMessage") as { message: string; type: string } | undefined;
}

describe("idempotency-key reset route action reads-your-writes under a lagging split replica", () => {
  heteroRunOpsPostgresTest(
    "returns the success toast for a run not yet replicated on the owning replica",
    async ({ prisma14, prisma17 }) => {
      h.resetCalls = [];

      // Seed the org/project/env + an authorized user on the LEGACY control-plane container.
      const suffix = "reset_route_guard";
      const organization = await prisma14.organization.create({
        data: { title: `Org ${suffix}`, slug: `org-${suffix}` },
      });
      const project = await prisma14.project.create({
        data: {
          name: `Project ${suffix}`,
          slug: `project-${suffix}`,
          externalRef: `proj_${suffix}`,
          organizationId: organization.id,
        },
      });
      const environment = await prisma14.runtimeEnvironment.create({
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
      const user = await prisma14.user.create({
        data: {
          id: h.userId,
          email: `${suffix}@example.com`,
          authenticationMethod: "MAGIC_LINK",
        },
      });
      await prisma14.orgMember.create({
        data: { organizationId: organization.id, userId: user.id, role: "ADMIN" },
      });

      // Build the REAL split store exactly as runStore.server holds it: the LEGACY store's replica lags
      // (frozen), its writer is live; the NEW store is live but empty. friendlyId reads fan out across
      // both stores' replicas (miss under lag) then, on the primary re-read, both writers (legacy hits).
      const legacyReplica = laggingReplica(prisma14, [{ model: "taskRun", mode: "missing" }]);
      const legacyStore = new PostgresRunStore({
        prisma: prisma14,
        readOnlyPrisma: legacyReplica.client,
        schemaVariant: "legacy",
      });
      const newStore = new PostgresRunStore({
        prisma: prisma17 as never,
        readOnlyPrisma: prisma17 as never,
        schemaVariant: "dedicated",
      });
      const router = new RoutingRunStore({ new: newStore, legacy: legacyStore });

      const runId = `run_${"c".repeat(25)}`; // cuid body -> LEGACY-resident
      const friendlyId = "run_reset_route_guard";
      const idempotencyKey = "user-supplied-key-guard";
      const taskIdentifier = "my-task";
      await legacyStore.createRun(
        buildCreateRunInput({
          runId,
          friendlyId,
          taskIdentifier,
          organizationId: organization.id,
          projectId: project.id,
          runtimeEnvironmentId: environment.id,
          idempotencyKey,
        })
      );

      // Sanity: the run exists on the owning primary but NOT on the (lagging) replica — the exact
      // read-your-writes window under test.
      expect(await router.findRun({ friendlyId }, { select: RESET_SELECT })).toBeNull();
      expect(
        await router.findRunOnPrimary({ friendlyId }, { select: RESET_SELECT })
      ).not.toBeNull();

      const primarySpy = vi.spyOn(router, "findRunOnPrimary");

      // Inject the live store + prisma the route will hold, then drive the REAL exported action.
      h.runStore = router;
      h.prisma = prisma14;

      const { action } =
        await import("~/routes/resources.orgs.$organizationSlug.projects.$projectParam.env.$envParam.runs.$runParam.idempotencyKey.reset");

      const request = new Request("http://localhost/reset", { method: "POST" });
      const response: Response = await action({
        request,
        params: {
          organizationSlug: organization.slug,
          projectParam: project.slug,
          envParam: environment.slug,
          runParam: friendlyId,
        },
        context: {},
      } as never);

      const toast = await readToast(response);

      // Property: the action re-reads the owning primary on the replica miss, finds the run, and
      // reaches the reset service — rather than returning not-found for a run the user can see.
      expect(legacyReplica.wasHit()).toBe(true); // the lagging replica path really executed in the action
      expect(primarySpy).toHaveBeenCalled(); // the owning-primary re-read was taken
      expect(h.resetCalls).toHaveLength(1); // ResetIdempotencyKeyService.call was reached
      expect(h.resetCalls[0]).toMatchObject({
        idempotencyKey,
        taskIdentifier,
        envId: environment.id,
      });
      expect(toast?.type).toBe("success");
      expect(toast?.message).toBe("Idempotency key reset successfully");
      // And it is NOT the not-found short-circuit.
      expect(toast?.message).not.toBe("Run not found");
    }
  );
});
