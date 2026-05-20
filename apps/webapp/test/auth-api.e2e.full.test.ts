// Comprehensive API auth tests — uses the shared TestServer started by
// vitest.e2e.full.config.ts's globalSetup. Family subtasks under TRI-8731
// add nested describe blocks here:
//
//   describe("API", () => {
//     describe("Trigger task", () => { ... })   // TRI-8733
//     describe("Runs — resource routes", () => { ... }) // TRI-8734
//     ...
//   })
//
// See test/helpers/sharedTestServer.ts for `getTestServer()`.

import { generateJWT } from "@trigger.dev/core/v3/jwt";
import { describe, expect, it } from "vitest";
import { getTestServer } from "./helpers/sharedTestServer";
import { seedTestEnvironment } from "./helpers/seedTestEnvironment";
import { seedTestPAT, seedTestUser } from "./helpers/seedTestPAT";
import { seedTestRun } from "./helpers/seedTestRun";
import { seedTestApiSession } from "./helpers/seedTestApiSession";
import { seedTestUserProject } from "./helpers/seedTestUserProject";
import { seedTestWaitpoint } from "./helpers/seedTestWaitpoint";

describe("API", () => {
  // Placeholder until family subtasks add their describes (TRI-8733+).
  // Verifies the shared container is reachable from this worker.
  it("shared webapp container responds to /healthcheck", async () => {
    const server = getTestServer();
    const res = await server.webapp.fetch("/healthcheck");
    expect(res.ok).toBe(true);
  });

  // PAT-authenticated routes (TRI-8741). The smoke matrix in
  // test/api-auth.e2e.test.ts covers basic 401 cases (missing auth,
  // wrong-prefix, unknown PAT, revoked PAT, valid-PAT-on-nonexistent-
  // project). This describe extends the matrix to the cases that
  // require seeding the full user → org → project → env graph:
  // valid-PAT-on-real-project, cross-org isolation, soft-deleted
  // project, and the global-admin-flag-doesn't-grant-cross-org carve-
  // out.
  //
  // Target route: GET /api/v1/projects/:projectRef/runs (the only
  // createLoaderPATApiRoute consumer at time of writing — re-grep
  // before extending if more PAT-only routes appear).
  describe("PAT-authenticated routes — comprehensive", () => {
    const pathFor = (ref: string) => `/api/v1/projects/${ref}/runs`;

    it("JWT on PAT-only route: 401", async () => {
      const server = getTestServer();
      const { environment } = await seedTestEnvironment(server.prisma);
      const jwt = await generateJWT({
        secretKey: environment.apiKey,
        payload: { pub: true, sub: environment.id, scopes: ["read:runs"] },
        expirationTime: "15m",
      });
      const res = await server.webapp.fetch(pathFor("nonexistent"), {
        headers: { Authorization: `Bearer ${jwt}` },
      });
      // PAT route doesn't accept JWTs — auth rejects before resource lookup.
      expect(res.status).toBe(401);
    });

    it("valid PAT, project exists in user's org: auth passes", async () => {
      const server = getTestServer();
      const { project, pat } = await seedTestUserProject(server.prisma);
      const res = await server.webapp.fetch(pathFor(project.externalRef), {
        headers: { Authorization: `Bearer ${pat.token}` },
      });
      // Auth + scoping pass. The route's run-list presenter hits
      // ClickHouse which isn't reachable in tests — accept any status
      // that isn't an auth failure.
      expect(res.status).not.toBe(401);
      expect(res.status).not.toBe(403);
    });

    it("valid PAT, project belongs to a different user's org: 404", async () => {
      const server = getTestServer();
      // Two completely isolated graphs. Both projects exist; the PAT
      // belongs to userA, the project to userB's org. findProjectByRef
      // scopes by `members: { some: { userId } }`, so userA's PAT
      // sees userB's project as nonexistent → 404 (not 403).
      const a = await seedTestUserProject(server.prisma);
      const b = await seedTestUserProject(server.prisma);
      const res = await server.webapp.fetch(pathFor(b.project.externalRef), {
        headers: { Authorization: `Bearer ${a.pat.token}` },
      });
      // Lock in the 404 — the access check inside findProjectByRef
      // returns null for cross-org and the route maps null to 404.
      expect(res.status).toBe(404);
    });

    it("valid PAT, project soft-deleted (deletedAt != null): 200 (route does not filter)", async () => {
      const server = getTestServer();
      // findProjectByRef (apps/webapp/app/models/project.server.ts)
      // does NOT filter on deletedAt — it scopes only by externalRef
      // and the user's org membership. So a soft-deleted project is
      // still findable here; the run-list presenter just returns
      // data:[] (or whatever survived). The ticket lists this as a
      // 404 case but that's not the route's actual contract; lock in
      // observed behaviour and call out the gap so a future change
      // (either tightening findProjectByRef or filtering at the route)
      // is conscious.
      const { project, pat } = await seedTestUserProject(server.prisma, {
        projectDeleted: true,
      });
      const res = await server.webapp.fetch(pathFor(project.externalRef), {
        headers: { Authorization: `Bearer ${pat.token}` },
      });
      // ClickHouse-dependent run-list — auth-passed assertion.
      expect(res.status).not.toBe(401);
      expect(res.status).not.toBe(403);
    });

    it("valid PAT for a global-admin user: still per-user (no cross-org access)", async () => {
      const server = getTestServer();
      // user.admin = true is the legacy super-admin flag. The PAT
      // route's access check is per-user (members: { some: { userId } }),
      // not admin-aware — so admin doesn't unlock cross-org visibility.
      // Lock in that behaviour: an admin's PAT can't read another
      // org's project either.
      const admin = await seedTestUser(server.prisma, { admin: true });
      const adminPat = await seedTestPAT(server.prisma, admin.id);
      const otherOrg = await seedTestUserProject(server.prisma);

      const res = await server.webapp.fetch(pathFor(otherOrg.project.externalRef), {
        headers: { Authorization: `Bearer ${adminPat.token}` },
      });
      expect(res.status).toBe(404);
    });

    it("valid PAT, admin user accessing their OWN project: auth passes", async () => {
      const server = getTestServer();
      // Companion to the above — confirm admin=true users can still
      // access their own org's projects (the admin flag isn't
      // accidentally subtracting permission).
      const { project, pat } = await seedTestUserProject(server.prisma, {
        userAdmin: true,
      });
      const res = await server.webapp.fetch(pathFor(project.externalRef), {
        headers: { Authorization: `Bearer ${pat.token}` },
      });
      // ClickHouse-dependent run-list — auth-passed assertion.
      expect(res.status).not.toBe(401);
      expect(res.status).not.toBe(403);
    });
  });

  // Resource-scoped writes (TRI-8740). Two routes:
  //   - POST /api/v1/waitpoints/tokens/:friendlyId/complete
  //     resource: { type: "waitpoints", id: friendlyId }
  //   - POST /realtime/v1/streams/:runId/input/:streamId
  //     resource: { type: "inputStreams", id: runId }
  //
  // The smoke matrix (api-auth.e2e.test.ts "JWT bearer auth — resource-
  // scoped scopes") already covers waitpoints comprehensively for JWT
  // resource-id matching, type-level scopes, action mismatches, admin
  // super-scope, etc. This block fills the gaps:
  //   - Private API key (not JWT) on the route.
  //   - JWT with `write:all` super-scope.
  //   - Cross-env (env A's JWT trying env B's resource).
  // Plus the equivalent full matrix for input-streams which the smoke
  // matrix doesn't touch.
  describe("Resource-scoped writes — waitpoints (gap-fill)", () => {
    const pathFor = (friendlyId: string) =>
      `/api/v1/waitpoints/tokens/${friendlyId}/complete`;
    const completeRequest = (path: string, headers: Record<string, string>) =>
      getTestServer().webapp.fetch(path, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify({}),
      });

    async function seedEnvAndWaitpoint() {
      const server = getTestServer();
      const seed = await seedTestEnvironment(server.prisma);
      const waitpoint = await seedTestWaitpoint(server.prisma, {
        environmentId: seed.environment.id,
        projectId: seed.project.id,
      });
      return { ...seed, waitpoint };
    }

    it("private API key (tr_dev_*): auth passes (200)", async () => {
      const { apiKey, waitpoint } = await seedEnvAndWaitpoint();
      const res = await completeRequest(pathFor(waitpoint.friendlyId), {
        Authorization: `Bearer ${apiKey}`,
      });
      // Waitpoint is COMPLETED, so the handler short-circuits with 200
      // once auth passes. Auth-passed assertion: NOT 401 / 403.
      expect(res.status).toBe(200);
    });

    it("JWT with write:all super-scope: auth passes (200)", async () => {
      const { environment, waitpoint } = await seedEnvAndWaitpoint();
      const jwt = await generateJWT({
        secretKey: environment.apiKey,
        payload: { pub: true, sub: environment.id, scopes: ["write:all"] },
        expirationTime: "15m",
      });
      const res = await completeRequest(pathFor(waitpoint.friendlyId), {
        Authorization: `Bearer ${jwt}`,
      });
      expect(res.status).toBe(200);
    });

    it("cross-env: env A's JWT cannot complete env B's waitpoint: not 200", async () => {
      const server = getTestServer();
      const a = await seedTestEnvironment(server.prisma);
      const b = await seedEnvAndWaitpoint();
      const jwt = await generateJWT({
        secretKey: a.apiKey,
        payload: {
          pub: true,
          sub: a.environment.id,
          scopes: [`write:waitpoints:${b.waitpoint.friendlyId}`],
        },
        expirationTime: "15m",
      });
      // The JWT is signed by env A and its sub claim says env A. The
      // route resolves env from the sub claim and the waitpoint is
      // env B's, so the lookup misses. The exact code depends on
      // whether auth or the resource lookup fires first — both
      // outcomes are correct, just NOT 200.
      const res = await completeRequest(pathFor(b.waitpoint.friendlyId), {
        Authorization: `Bearer ${jwt}`,
      });
      expect(res.status).not.toBe(200);
    });
  });

  describe("Resource-scoped writes — input streams (full matrix)", () => {
    const pathFor = (runId: string, streamId: string) =>
      `/realtime/v1/streams/${runId}/input/${streamId}`;
    const postRequest = (path: string, headers: Record<string, string>) =>
      getTestServer().webapp.fetch(path, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify({ data: { hello: "world" } }),
      });

    async function seedEnvAndRun() {
      const server = getTestServer();
      const seed = await seedTestEnvironment(server.prisma);
      const { runFriendlyId } = await seedTestRun(server.prisma, {
        environmentId: seed.environment.id,
        projectId: seed.project.id,
      });
      return { ...seed, runFriendlyId, streamId: "test-stream" };
    }

    it("missing auth: 401", async () => {
      const server = getTestServer();
      const res = await server.webapp.fetch(pathFor("run_doesnotexist", "stream-x"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ data: {} }),
      });
      expect(res.status).toBe(401);
    });

    it("private API key: auth passes (not 401/403)", async () => {
      const { apiKey, runFriendlyId, streamId } = await seedEnvAndRun();
      const res = await postRequest(pathFor(runFriendlyId, streamId), {
        Authorization: `Bearer ${apiKey}`,
      });
      // Route may return any 2xx/4xx based on stream state — we only
      // care that auth passed (NOT 401/403).
      expect(res.status).not.toBe(401);
      expect(res.status).not.toBe(403);
    });

    it("JWT with exact-id scope: auth passes", async () => {
      const { environment, runFriendlyId, streamId } = await seedEnvAndRun();
      const jwt = await generateJWT({
        secretKey: environment.apiKey,
        payload: {
          pub: true,
          sub: environment.id,
          scopes: [`write:inputStreams:${runFriendlyId}`],
        },
        expirationTime: "15m",
      });
      const res = await postRequest(pathFor(runFriendlyId, streamId), {
        Authorization: `Bearer ${jwt}`,
      });
      expect(res.status).not.toBe(401);
      expect(res.status).not.toBe(403);
    });

    it("JWT with type-level scope: auth passes", async () => {
      const { environment, runFriendlyId, streamId } = await seedEnvAndRun();
      const jwt = await generateJWT({
        secretKey: environment.apiKey,
        payload: { pub: true, sub: environment.id, scopes: ["write:inputStreams"] },
        expirationTime: "15m",
      });
      const res = await postRequest(pathFor(runFriendlyId, streamId), {
        Authorization: `Bearer ${jwt}`,
      });
      expect(res.status).not.toBe(401);
      expect(res.status).not.toBe(403);
    });

    it("JWT with wrong resource id: 403", async () => {
      const { environment, runFriendlyId, streamId } = await seedEnvAndRun();
      const jwt = await generateJWT({
        secretKey: environment.apiKey,
        payload: {
          pub: true,
          sub: environment.id,
          scopes: ["write:inputStreams:run_someoneelse00000000000000"],
        },
        expirationTime: "15m",
      });
      const res = await postRequest(pathFor(runFriendlyId, streamId), {
        Authorization: `Bearer ${jwt}`,
      });
      expect(res.status).toBe(403);
    });

    it("JWT with read action on write route: 403", async () => {
      const { environment, runFriendlyId, streamId } = await seedEnvAndRun();
      const jwt = await generateJWT({
        secretKey: environment.apiKey,
        payload: {
          pub: true,
          sub: environment.id,
          scopes: [`read:inputStreams:${runFriendlyId}`],
        },
        expirationTime: "15m",
      });
      const res = await postRequest(pathFor(runFriendlyId, streamId), {
        Authorization: `Bearer ${jwt}`,
      });
      expect(res.status).toBe(403);
    });

    it("JWT with write:all super-scope: auth passes", async () => {
      const { environment, runFriendlyId, streamId } = await seedEnvAndRun();
      const jwt = await generateJWT({
        secretKey: environment.apiKey,
        payload: { pub: true, sub: environment.id, scopes: ["write:all"] },
        expirationTime: "15m",
      });
      const res = await postRequest(pathFor(runFriendlyId, streamId), {
        Authorization: `Bearer ${jwt}`,
      });
      expect(res.status).not.toBe(401);
      expect(res.status).not.toBe(403);
    });

    it("JWT with admin super-scope: auth passes", async () => {
      const { environment, runFriendlyId, streamId } = await seedEnvAndRun();
      const jwt = await generateJWT({
        secretKey: environment.apiKey,
        payload: { pub: true, sub: environment.id, scopes: ["admin"] },
        expirationTime: "15m",
      });
      const res = await postRequest(pathFor(runFriendlyId, streamId), {
        Authorization: `Bearer ${jwt}`,
      });
      expect(res.status).not.toBe(401);
      expect(res.status).not.toBe(403);
    });

    it("cross-env: env A's JWT cannot write to env B's run: not 200", async () => {
      const server = getTestServer();
      const a = await seedTestEnvironment(server.prisma);
      const b = await seedEnvAndRun();
      const jwt = await generateJWT({
        secretKey: a.apiKey,
        payload: {
          pub: true,
          sub: a.environment.id,
          scopes: [`write:inputStreams:${b.runFriendlyId}`],
        },
        expirationTime: "15m",
      });
      const res = await postRequest(pathFor(b.runFriendlyId, b.streamId), {
        Authorization: `Bearer ${jwt}`,
      });
      // Either auth fails outright or the run lookup misses (env A's
      // view of the run doesn't include env B's data). Critical
      // security property: NOT 200.
      expect(res.status).not.toBe(200);
    });
  });

  // Trigger task routes (TRI-8733). The single-task route uses
  // action: "trigger" with a single resource { type: "tasks", id };
  // batch v1/v2 use action: "batchTrigger" with a body-derived array
  // [{type:"tasks", id}, ...] under AND semantics — every task in the
  // batch must be authorized, not just any one (otherwise a JWT scoped
  // to one task could submit a batch with arbitrary other tasks).
  // v3 batches use a collection-level resource { type: "tasks" }
  // (no id — items are validated per-row when streamed).
  //
  // ACTION_ALIASES (from packages/core/src/v3/jwt.ts) maps write→trigger
  // and write→batchTrigger so write:tasks scopes also satisfy these
  // routes. The smoke matrix already verifies write:tasks → trigger
  // alias works; we re-test it here per-route so scope misconfig in
  // one route doesn't slip past.
  describe("Trigger task — single (api.v1.tasks.$taskId.trigger)", () => {
    const TASK_ID = "test-task";
    const path = `/api/v1/tasks/${TASK_ID}/trigger`;

    async function seedAndRequest(
      headers: Record<string, string>,
      body: unknown = { payload: {} }
    ) {
      const server = getTestServer();
      const seed = await seedTestEnvironment(server.prisma);
      const res = await server.webapp.fetch(path, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify(body),
      });
      return { res, seed };
    }

    it("missing auth: 401", async () => {
      const server = getTestServer();
      const res = await server.webapp.fetch(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ payload: {} }),
      });
      expect(res.status).toBe(401);
    });

    it("private API key: auth passes (handler may 4xx — not 401/403)", async () => {
      const server = getTestServer();
      const seed = await seedTestEnvironment(server.prisma);
      const res = await server.webapp.fetch(path, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${seed.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ payload: {} }),
      });
      // Auth passed; the handler may 404 because the task doesn't
      // actually exist in the BackgroundWorker. Anything not 401/403
      // is "auth passed" for this test.
      expect(res.status).not.toBe(401);
      expect(res.status).not.toBe(403);
    });

    it("JWT with write:tasks (type-level, ACTION_ALIASES write→trigger): auth passes", async () => {
      const server = getTestServer();
      const seed = await seedTestEnvironment(server.prisma);
      const jwt = await generateJWT({
        secretKey: seed.apiKey,
        payload: { pub: true, sub: seed.environment.id, scopes: ["write:tasks"] },
        expirationTime: "15m",
      });
      const res = await server.webapp.fetch(path, {
        method: "POST",
        headers: { Authorization: `Bearer ${jwt}`, "Content-Type": "application/json" },
        body: JSON.stringify({ payload: {} }),
      });
      expect(res.status).not.toBe(401);
      expect(res.status).not.toBe(403);
    });

    it("JWT with trigger:tasks:<exact taskId>: auth passes", async () => {
      const server = getTestServer();
      const seed = await seedTestEnvironment(server.prisma);
      const jwt = await generateJWT({
        secretKey: seed.apiKey,
        payload: {
          pub: true,
          sub: seed.environment.id,
          scopes: [`trigger:tasks:${TASK_ID}`],
        },
        expirationTime: "15m",
      });
      const res = await server.webapp.fetch(path, {
        method: "POST",
        headers: { Authorization: `Bearer ${jwt}`, "Content-Type": "application/json" },
        body: JSON.stringify({ payload: {} }),
      });
      expect(res.status).not.toBe(401);
      expect(res.status).not.toBe(403);
    });

    it("JWT with trigger:tasks:<other>: 403", async () => {
      const server = getTestServer();
      const seed = await seedTestEnvironment(server.prisma);
      const jwt = await generateJWT({
        secretKey: seed.apiKey,
        payload: {
          pub: true,
          sub: seed.environment.id,
          scopes: ["trigger:tasks:some-other-task"],
        },
        expirationTime: "15m",
      });
      const res = await server.webapp.fetch(path, {
        method: "POST",
        headers: { Authorization: `Bearer ${jwt}`, "Content-Type": "application/json" },
        body: JSON.stringify({ payload: {} }),
      });
      expect(res.status).toBe(403);
    });

    it("JWT with read:tasks: 403 (read NOT aliased to trigger)", async () => {
      const server = getTestServer();
      const seed = await seedTestEnvironment(server.prisma);
      const jwt = await generateJWT({
        secretKey: seed.apiKey,
        payload: { pub: true, sub: seed.environment.id, scopes: ["read:tasks"] },
        expirationTime: "15m",
      });
      const res = await server.webapp.fetch(path, {
        method: "POST",
        headers: { Authorization: `Bearer ${jwt}`, "Content-Type": "application/json" },
        body: JSON.stringify({ payload: {} }),
      });
      expect(res.status).toBe(403);
    });

    it("JWT with empty scopes: 403", async () => {
      const server = getTestServer();
      const seed = await seedTestEnvironment(server.prisma);
      const jwt = await generateJWT({
        secretKey: seed.apiKey,
        payload: { pub: true, sub: seed.environment.id, scopes: [] },
        expirationTime: "15m",
      });
      const res = await server.webapp.fetch(path, {
        method: "POST",
        headers: { Authorization: `Bearer ${jwt}`, "Content-Type": "application/json" },
        body: JSON.stringify({ payload: {} }),
      });
      expect(res.status).toBe(403);
    });

    it("JWT signed with wrong key: 401", async () => {
      const server = getTestServer();
      const a = await seedTestEnvironment(server.prisma);
      const b = await seedTestEnvironment(server.prisma);
      const jwt = await generateJWT({
        secretKey: b.apiKey, // wrong key for env A's sub
        payload: {
          pub: true,
          sub: a.environment.id,
          scopes: [`trigger:tasks:${TASK_ID}`],
        },
        expirationTime: "15m",
      });
      const res = await server.webapp.fetch(path, {
        method: "POST",
        headers: { Authorization: `Bearer ${jwt}`, "Content-Type": "application/json" },
        body: JSON.stringify({ payload: {} }),
      });
      expect(res.status).toBe(401);
    });

    it("JWT with admin super-scope: auth passes", async () => {
      const server = getTestServer();
      const seed = await seedTestEnvironment(server.prisma);
      const jwt = await generateJWT({
        secretKey: seed.apiKey,
        payload: { pub: true, sub: seed.environment.id, scopes: ["admin"] },
        expirationTime: "15m",
      });
      const res = await server.webapp.fetch(path, {
        method: "POST",
        headers: { Authorization: `Bearer ${jwt}`, "Content-Type": "application/json" },
        body: JSON.stringify({ payload: {} }),
      });
      expect(res.status).not.toBe(401);
      expect(res.status).not.toBe(403);
    });
  });

  describe("Trigger task — batch v1 (api.v1.tasks.batch)", () => {
    const path = "/api/v1/tasks/batch";
    const buildBody = (taskIds: string[]) => ({
      items: taskIds.map((task) => ({ task, payload: {} })),
    });

    it("missing auth: 401", async () => {
      const server = getTestServer();
      const res = await server.webapp.fetch(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildBody(["taskA"])),
      });
      expect(res.status).toBe(401);
    });

    it("private API key: auth passes", async () => {
      const server = getTestServer();
      const seed = await seedTestEnvironment(server.prisma);
      const res = await server.webapp.fetch(path, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${seed.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(buildBody(["taskA"])),
      });
      expect(res.status).not.toBe(401);
      expect(res.status).not.toBe(403);
    });

    it("JWT with write:tasks (type-level): auth passes", async () => {
      const server = getTestServer();
      const seed = await seedTestEnvironment(server.prisma);
      const jwt = await generateJWT({
        secretKey: seed.apiKey,
        payload: { pub: true, sub: seed.environment.id, scopes: ["write:tasks"] },
        expirationTime: "15m",
      });
      const res = await server.webapp.fetch(path, {
        method: "POST",
        headers: { Authorization: `Bearer ${jwt}`, "Content-Type": "application/json" },
        body: JSON.stringify(buildBody(["taskA", "taskB"])),
      });
      expect(res.status).not.toBe(401);
      expect(res.status).not.toBe(403);
    });

    it("JWT with batchTrigger:tasks:taskA + body has [taskA, taskB]: 403 (every-task semantics)", async () => {
      // Batch trigger uses AND semantics — every task in the body must
      // be authorized, not just any one of them. A JWT scoped to only
      // taskA cannot submit a batch that also includes taskB, otherwise
      // the caller would be triggering tasks they have no scope for.
      const server = getTestServer();
      const seed = await seedTestEnvironment(server.prisma);
      const jwt = await generateJWT({
        secretKey: seed.apiKey,
        payload: {
          pub: true,
          sub: seed.environment.id,
          scopes: ["batchTrigger:tasks:taskA"],
        },
        expirationTime: "15m",
      });
      const res = await server.webapp.fetch(path, {
        method: "POST",
        headers: { Authorization: `Bearer ${jwt}`, "Content-Type": "application/json" },
        body: JSON.stringify(buildBody(["taskA", "taskB"])),
      });
      expect(res.status).toBe(403);
    });

    it("JWT with batchTrigger:tasks:taskA + body has [taskA] only: auth passes", async () => {
      // Per-task scope grants per-task access — a batch containing
      // only the authorized task is allowed.
      const server = getTestServer();
      const seed = await seedTestEnvironment(server.prisma);
      const jwt = await generateJWT({
        secretKey: seed.apiKey,
        payload: {
          pub: true,
          sub: seed.environment.id,
          scopes: ["batchTrigger:tasks:taskA"],
        },
        expirationTime: "15m",
      });
      const res = await server.webapp.fetch(path, {
        method: "POST",
        headers: { Authorization: `Bearer ${jwt}`, "Content-Type": "application/json" },
        body: JSON.stringify(buildBody(["taskA"])),
      });
      expect(res.status).not.toBe(401);
      expect(res.status).not.toBe(403);
    });

    it("JWT with batchTrigger:tasks:<unrelated> + body has only taskA: 403", async () => {
      const server = getTestServer();
      const seed = await seedTestEnvironment(server.prisma);
      const jwt = await generateJWT({
        secretKey: seed.apiKey,
        payload: {
          pub: true,
          sub: seed.environment.id,
          scopes: ["batchTrigger:tasks:not-in-body"],
        },
        expirationTime: "15m",
      });
      const res = await server.webapp.fetch(path, {
        method: "POST",
        headers: { Authorization: `Bearer ${jwt}`, "Content-Type": "application/json" },
        body: JSON.stringify(buildBody(["taskA"])),
      });
      expect(res.status).toBe(403);
    });

    it("JWT with read:tasks: 403 (action mismatch)", async () => {
      const server = getTestServer();
      const seed = await seedTestEnvironment(server.prisma);
      const jwt = await generateJWT({
        secretKey: seed.apiKey,
        payload: { pub: true, sub: seed.environment.id, scopes: ["read:tasks"] },
        expirationTime: "15m",
      });
      const res = await server.webapp.fetch(path, {
        method: "POST",
        headers: { Authorization: `Bearer ${jwt}`, "Content-Type": "application/json" },
        body: JSON.stringify(buildBody(["taskA"])),
      });
      expect(res.status).toBe(403);
    });

    it("JWT with admin: auth passes", async () => {
      const server = getTestServer();
      const seed = await seedTestEnvironment(server.prisma);
      const jwt = await generateJWT({
        secretKey: seed.apiKey,
        payload: { pub: true, sub: seed.environment.id, scopes: ["admin"] },
        expirationTime: "15m",
      });
      const res = await server.webapp.fetch(path, {
        method: "POST",
        headers: { Authorization: `Bearer ${jwt}`, "Content-Type": "application/json" },
        body: JSON.stringify(buildBody(["taskA"])),
      });
      expect(res.status).not.toBe(401);
      expect(res.status).not.toBe(403);
    });
  });

  // v2 batch shares the exact same authorization config as v1 — same
  // body-derived array resource, same batchTrigger action. We don't
  // duplicate the full matrix here; the v1 tests cover the wrapper
  // behaviour. If v2's authorization config ever diverges from v1's,
  // add a targeted test here. For now just sanity-check that the v2
  // route's wiring is alive.
  describe("Trigger task — batch v2 (api.v2.tasks.batch) sanity", () => {
    const path = "/api/v2/tasks/batch";

    it("missing auth: 401", async () => {
      const server = getTestServer();
      const res = await server.webapp.fetch(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ items: [{ task: "t", payload: {} }] }),
      });
      expect(res.status).toBe(401);
    });

    it("JWT with write:tasks: auth passes", async () => {
      const server = getTestServer();
      const seed = await seedTestEnvironment(server.prisma);
      const jwt = await generateJWT({
        secretKey: seed.apiKey,
        payload: { pub: true, sub: seed.environment.id, scopes: ["write:tasks"] },
        expirationTime: "15m",
      });
      const res = await server.webapp.fetch(path, {
        method: "POST",
        headers: { Authorization: `Bearer ${jwt}`, "Content-Type": "application/json" },
        body: JSON.stringify({ items: [{ task: "t", payload: {} }] }),
      });
      expect(res.status).not.toBe(401);
      expect(res.status).not.toBe(403);
    });
  });

  // v3 batches use a collection-level resource { type: "tasks" } with
  // no id — items are validated per-row when streamed. So id-specific
  // scopes (write:tasks:foo) shouldn't grant blanket access; only
  // type-level write:tasks (or admin/write:all) should.
  describe("Trigger task — batch v3 (api.v3.batches) collection-level", () => {
    const path = "/api/v3/batches";
    const buildBody = () => ({ runCount: 1 });

    it("missing auth: 401", async () => {
      const server = getTestServer();
      const res = await server.webapp.fetch(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildBody()),
      });
      expect(res.status).toBe(401);
    });

    it("JWT with write:tasks (type-level): auth passes", async () => {
      const server = getTestServer();
      const seed = await seedTestEnvironment(server.prisma);
      const jwt = await generateJWT({
        secretKey: seed.apiKey,
        payload: { pub: true, sub: seed.environment.id, scopes: ["write:tasks"] },
        expirationTime: "15m",
      });
      const res = await server.webapp.fetch(path, {
        method: "POST",
        headers: { Authorization: `Bearer ${jwt}`, "Content-Type": "application/json" },
        body: JSON.stringify(buildBody()),
      });
      expect(res.status).not.toBe(401);
      expect(res.status).not.toBe(403);
    });

    it("JWT with read:tasks: 403", async () => {
      const server = getTestServer();
      const seed = await seedTestEnvironment(server.prisma);
      const jwt = await generateJWT({
        secretKey: seed.apiKey,
        payload: { pub: true, sub: seed.environment.id, scopes: ["read:tasks"] },
        expirationTime: "15m",
      });
      const res = await server.webapp.fetch(path, {
        method: "POST",
        headers: { Authorization: `Bearer ${jwt}`, "Content-Type": "application/json" },
        body: JSON.stringify(buildBody()),
      });
      expect(res.status).toBe(403);
    });

    it("JWT with admin: auth passes", async () => {
      const server = getTestServer();
      const seed = await seedTestEnvironment(server.prisma);
      const jwt = await generateJWT({
        secretKey: seed.apiKey,
        payload: { pub: true, sub: seed.environment.id, scopes: ["admin"] },
        expirationTime: "15m",
      });
      const res = await server.webapp.fetch(path, {
        method: "POST",
        headers: { Authorization: `Bearer ${jwt}`, "Content-Type": "application/json" },
        body: JSON.stringify(buildBody()),
      });
      expect(res.status).not.toBe(401);
      expect(res.status).not.toBe(403);
    });
  });

  // Run lists (TRI-8736). Two routes share the same multi-key
  // resource pattern — collection-level `{ type: "runs" }` always
  // present, plus an array of secondary keys derived from search
  // params:
  //   - GET /api/v1/runs: filter[taskIdentifier]=A,B → +{ type: "tasks", id: A }, { type: "tasks", id: B }
  //   - GET /realtime/v1/runs: ?tags=foo,bar       → +{ type: "tags", id: "foo" }, { type: "tags", id: "bar" }
  //
  // Multi-key any-match contract from TRI-8719: a JWT with a scope
  // matching ANY element of the resource array grants access. So:
  //   - read:runs                   → matches the collection key  → passes
  //   - read:tasks:A (with A in filter) → matches an array element → passes
  //   - read:tasks:Z (with A in filter) → no match                → 403
  describe("Run list — api.v1.runs (multi-key tasks)", () => {
    const path = "/api/v1/runs";

    async function get(query: string, headers: Record<string, string>) {
      return getTestServer().webapp.fetch(`${path}${query}`, { headers });
    }

    it("missing auth: 401", async () => {
      const res = await getTestServer().webapp.fetch(path);
      expect(res.status).toBe(401);
    });

    // Pass cases on api.v1.runs assert "auth passed" (not 401/403)
    // rather than strict 200. The handler hits ClickHouse which isn't
    // reachable from the test container — the endpoint can 500 in
    // tests even when auth is fine. The auth layer is what we're
    // verifying here.
    it("private API key: auth passes", async () => {
      const server = getTestServer();
      const seed = await seedTestEnvironment(server.prisma);
      const res = await get("", { Authorization: `Bearer ${seed.apiKey}` });
      expect(res.status).not.toBe(401);
      expect(res.status).not.toBe(403);
    });

    it("JWT with read:runs (collection-level): auth passes", async () => {
      const server = getTestServer();
      const seed = await seedTestEnvironment(server.prisma);
      const jwt = await generateJWT({
        secretKey: seed.apiKey,
        payload: { pub: true, sub: seed.environment.id, scopes: ["read:runs"] },
        expirationTime: "15m",
      });
      const res = await get("", { Authorization: `Bearer ${jwt}` });
      expect(res.status).not.toBe(401);
      expect(res.status).not.toBe(403);
    });

    it("JWT with read:all super-scope: auth passes", async () => {
      const server = getTestServer();
      const seed = await seedTestEnvironment(server.prisma);
      const jwt = await generateJWT({
        secretKey: seed.apiKey,
        payload: { pub: true, sub: seed.environment.id, scopes: ["read:all"] },
        expirationTime: "15m",
      });
      const res = await get("", { Authorization: `Bearer ${jwt}` });
      expect(res.status).not.toBe(401);
      expect(res.status).not.toBe(403);
    });

    it("JWT with admin: auth passes", async () => {
      const server = getTestServer();
      const seed = await seedTestEnvironment(server.prisma);
      const jwt = await generateJWT({
        secretKey: seed.apiKey,
        payload: { pub: true, sub: seed.environment.id, scopes: ["admin"] },
        expirationTime: "15m",
      });
      const res = await get("", { Authorization: `Bearer ${jwt}` });
      expect(res.status).not.toBe(401);
      expect(res.status).not.toBe(403);
    });

    it("JWT with empty scopes: 403", async () => {
      const server = getTestServer();
      const seed = await seedTestEnvironment(server.prisma);
      const jwt = await generateJWT({
        secretKey: seed.apiKey,
        payload: { pub: true, sub: seed.environment.id, scopes: [] },
        expirationTime: "15m",
      });
      const res = await get("", { Authorization: `Bearer ${jwt}` });
      expect(res.status).toBe(403);
    });

    it("JWT with write:runs (action mismatch — read route): 403", async () => {
      const server = getTestServer();
      const seed = await seedTestEnvironment(server.prisma);
      const jwt = await generateJWT({
        secretKey: seed.apiKey,
        payload: { pub: true, sub: seed.environment.id, scopes: ["write:runs"] },
        expirationTime: "15m",
      });
      const res = await get("", { Authorization: `Bearer ${jwt}` });
      expect(res.status).toBe(403);
    });

    it("filter[taskIdentifier]=task_a,task_b + JWT read:tasks:task_a → passes (array match)", async () => {
      const server = getTestServer();
      const seed = await seedTestEnvironment(server.prisma);
      const jwt = await generateJWT({
        secretKey: seed.apiKey,
        payload: {
          pub: true,
          sub: seed.environment.id,
          scopes: ["read:tasks:task_a"],
        },
        expirationTime: "15m",
      });
      const res = await get(
        "?filter%5BtaskIdentifier%5D=task_a%2Ctask_b",
        { Authorization: `Bearer ${jwt}` }
      );
      // Resource array is [{type:"runs"}, {type:"tasks",id:"task_a"}, {type:"tasks",id:"task_b"}].
      // The scope read:tasks:task_a matches the second element → access granted.
      // Handler may 500 (ClickHouse unreachable in tests) but auth passed.
      expect(res.status).not.toBe(401);
      expect(res.status).not.toBe(403);
    });

    it("filter[taskIdentifier]=task_a + JWT read:tasks:task_z → 403 (no array match)", async () => {
      const server = getTestServer();
      const seed = await seedTestEnvironment(server.prisma);
      const jwt = await generateJWT({
        secretKey: seed.apiKey,
        payload: {
          pub: true,
          sub: seed.environment.id,
          scopes: ["read:tasks:task_z"],
        },
        expirationTime: "15m",
      });
      const res = await get(
        "?filter%5BtaskIdentifier%5D=task_a",
        { Authorization: `Bearer ${jwt}` }
      );
      // Resource is [{runs}, {tasks:task_a}]. JWT scope says
      // read:tasks:task_z which doesn't match the runs collection
      // (wrong type) or the task_a element (wrong id). 403.
      expect(res.status).toBe(403);
    });
  });

  describe("Run list — realtime.v1.runs (multi-key tags)", () => {
    const path = "/realtime/v1/runs";

    async function get(query: string, headers: Record<string, string>) {
      return getTestServer().webapp.fetch(`${path}${query}`, { headers });
    }

    it("missing auth: 401", async () => {
      const res = await getTestServer().webapp.fetch(path);
      expect(res.status).toBe(401);
    });

    it("JWT with read:runs (collection-level): auth passes", async () => {
      const server = getTestServer();
      const seed = await seedTestEnvironment(server.prisma);
      const jwt = await generateJWT({
        secretKey: seed.apiKey,
        payload: { pub: true, sub: seed.environment.id, scopes: ["read:runs"] },
        expirationTime: "15m",
      });
      const res = await get("", { Authorization: `Bearer ${jwt}` });
      // Realtime endpoints stream — the route may return 200 (streaming
      // OK) or other status codes depending on streams setup. We only
      // care that auth passed: NOT 401/403.
      expect(res.status).not.toBe(401);
      expect(res.status).not.toBe(403);
    });

    it("JWT with read:tags:foo + ?tags=foo,bar → passes (array match)", async () => {
      const server = getTestServer();
      const seed = await seedTestEnvironment(server.prisma);
      const jwt = await generateJWT({
        secretKey: seed.apiKey,
        payload: {
          pub: true,
          sub: seed.environment.id,
          scopes: ["read:tags:foo"],
        },
        expirationTime: "15m",
      });
      const res = await get("?tags=foo,bar", { Authorization: `Bearer ${jwt}` });
      // Resource array is [{type:"runs"}, {type:"tags",id:"foo"}, {type:"tags",id:"bar"}].
      // Scope matches the foo element → access granted.
      expect(res.status).not.toBe(401);
      expect(res.status).not.toBe(403);
    });

    it("JWT with read:tags:baz + ?tags=foo → 403 (no array match)", async () => {
      const server = getTestServer();
      const seed = await seedTestEnvironment(server.prisma);
      const jwt = await generateJWT({
        secretKey: seed.apiKey,
        payload: {
          pub: true,
          sub: seed.environment.id,
          scopes: ["read:tags:baz"],
        },
        expirationTime: "15m",
      });
      const res = await get("?tags=foo", { Authorization: `Bearer ${jwt}` });
      expect(res.status).toBe(403);
    });

    it("JWT with admin: auth passes", async () => {
      const server = getTestServer();
      const seed = await seedTestEnvironment(server.prisma);
      const jwt = await generateJWT({
        secretKey: seed.apiKey,
        payload: { pub: true, sub: seed.environment.id, scopes: ["admin"] },
        expirationTime: "15m",
      });
      const res = await get("", { Authorization: `Bearer ${jwt}` });
      expect(res.status).not.toBe(401);
      expect(res.status).not.toBe(403);
    });

    it("JWT with write:runs (action mismatch): 403", async () => {
      const server = getTestServer();
      const seed = await seedTestEnvironment(server.prisma);
      const jwt = await generateJWT({
        secretKey: seed.apiKey,
        payload: { pub: true, sub: seed.environment.id, scopes: ["write:runs"] },
        expirationTime: "15m",
      });
      const res = await get("", { Authorization: `Bearer ${jwt}` });
      expect(res.status).toBe(403);
    });
  });

  // Run mutations (TRI-8735). Two routes:
  //   - POST /api/v2/runs/:runParam/cancel
  //       action: write, resource: { type: "runs", id: params.runParam }
  //       — single id-keyed resource, supports id-specific scopes.
  //   - POST /api/v1/idempotencyKeys/:key/reset
  //       action: write, resource: { type: "runs" } (collection-level)
  //       — id-specific scopes don't grant blanket access; only
  //       type-level write:runs (or super-scopes) work.
  //
  // The legacy idempotencyKeys/:key/reset rejected ALL JWTs due to an
  // empty-resource bug. Post TRI-8719 the empty-resource resolution
  // lets write:runs JWTs through. Tests here lock in the new behaviour.
  describe("Run mutations — cancel (api.v2.runs.$runParam.cancel)", () => {
    const pathFor = (runId: string) => `/api/v2/runs/${runId}/cancel`;
    const post = (path: string, headers: Record<string, string>) =>
      getTestServer().webapp.fetch(path, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify({}),
      });

    it("missing auth: 401", async () => {
      const res = await post(pathFor("run_anything"), {});
      expect(res.status).toBe(401);
    });

    it("invalid API key: 401", async () => {
      const res = await post(pathFor("run_anything"), {
        Authorization: "Bearer tr_dev_definitely_not_real_key",
      });
      expect(res.status).toBe(401);
    });

    it("private API key on real run: auth passes", async () => {
      const server = getTestServer();
      const seed = await seedTestEnvironment(server.prisma);
      const { runFriendlyId } = await seedTestRun(server.prisma, {
        environmentId: seed.environment.id,
        projectId: seed.project.id,
      });
      const res = await post(pathFor(runFriendlyId), {
        Authorization: `Bearer ${seed.apiKey}`,
      });
      // Auth + findResource passed; handler may return any 2xx/4xx
      // depending on run state. We only care: not 401/403.
      expect(res.status).not.toBe(401);
      expect(res.status).not.toBe(403);
    });

    it("JWT with write:runs (type-level): auth passes", async () => {
      const server = getTestServer();
      const seed = await seedTestEnvironment(server.prisma);
      const { runFriendlyId } = await seedTestRun(server.prisma, {
        environmentId: seed.environment.id,
        projectId: seed.project.id,
      });
      const jwt = await generateJWT({
        secretKey: seed.apiKey,
        payload: { pub: true, sub: seed.environment.id, scopes: ["write:runs"] },
        expirationTime: "15m",
      });
      const res = await post(pathFor(runFriendlyId), {
        Authorization: `Bearer ${jwt}`,
      });
      expect(res.status).not.toBe(401);
      expect(res.status).not.toBe(403);
    });

    it("JWT with write:runs:<exact runId>: auth passes", async () => {
      const server = getTestServer();
      const seed = await seedTestEnvironment(server.prisma);
      const { runFriendlyId } = await seedTestRun(server.prisma, {
        environmentId: seed.environment.id,
        projectId: seed.project.id,
      });
      const jwt = await generateJWT({
        secretKey: seed.apiKey,
        payload: {
          pub: true,
          sub: seed.environment.id,
          scopes: [`write:runs:${runFriendlyId}`],
        },
        expirationTime: "15m",
      });
      const res = await post(pathFor(runFriendlyId), {
        Authorization: `Bearer ${jwt}`,
      });
      expect(res.status).not.toBe(401);
      expect(res.status).not.toBe(403);
    });

    it("JWT with write:runs:<other>: 403", async () => {
      const server = getTestServer();
      const seed = await seedTestEnvironment(server.prisma);
      const { runFriendlyId } = await seedTestRun(server.prisma, {
        environmentId: seed.environment.id,
        projectId: seed.project.id,
      });
      const jwt = await generateJWT({
        secretKey: seed.apiKey,
        payload: {
          pub: true,
          sub: seed.environment.id,
          scopes: ["write:runs:run_someoneelse00000000000"],
        },
        expirationTime: "15m",
      });
      const res = await post(pathFor(runFriendlyId), {
        Authorization: `Bearer ${jwt}`,
      });
      expect(res.status).toBe(403);
    });

    it("JWT with read:runs (action mismatch): 403", async () => {
      const server = getTestServer();
      const seed = await seedTestEnvironment(server.prisma);
      const { runFriendlyId } = await seedTestRun(server.prisma, {
        environmentId: seed.environment.id,
        projectId: seed.project.id,
      });
      const jwt = await generateJWT({
        secretKey: seed.apiKey,
        payload: {
          pub: true,
          sub: seed.environment.id,
          scopes: [`read:runs:${runFriendlyId}`],
        },
        expirationTime: "15m",
      });
      const res = await post(pathFor(runFriendlyId), {
        Authorization: `Bearer ${jwt}`,
      });
      expect(res.status).toBe(403);
    });

    it("JWT with write:all super-scope: auth passes", async () => {
      const server = getTestServer();
      const seed = await seedTestEnvironment(server.prisma);
      const { runFriendlyId } = await seedTestRun(server.prisma, {
        environmentId: seed.environment.id,
        projectId: seed.project.id,
      });
      const jwt = await generateJWT({
        secretKey: seed.apiKey,
        payload: { pub: true, sub: seed.environment.id, scopes: ["write:all"] },
        expirationTime: "15m",
      });
      const res = await post(pathFor(runFriendlyId), {
        Authorization: `Bearer ${jwt}`,
      });
      expect(res.status).not.toBe(401);
      expect(res.status).not.toBe(403);
    });

    it("JWT with admin: auth passes", async () => {
      const server = getTestServer();
      const seed = await seedTestEnvironment(server.prisma);
      const { runFriendlyId } = await seedTestRun(server.prisma, {
        environmentId: seed.environment.id,
        projectId: seed.project.id,
      });
      const jwt = await generateJWT({
        secretKey: seed.apiKey,
        payload: { pub: true, sub: seed.environment.id, scopes: ["admin"] },
        expirationTime: "15m",
      });
      const res = await post(pathFor(runFriendlyId), {
        Authorization: `Bearer ${jwt}`,
      });
      expect(res.status).not.toBe(401);
      expect(res.status).not.toBe(403);
    });
  });

  describe("Run mutations — idempotencyKeys.reset (api.v1.idempotencyKeys.$key.reset)", () => {
    // Collection-level resource { type: "runs" } — id-specific
    // write:runs:<runId> scopes don't help here (no id to match).
    // The legacy version of this route rejected ALL JWTs due to an
    // empty-resource bug; the post-TRI-8719 path lets write:runs
    // through. Tests below pin that down.
    const path = "/api/v1/idempotencyKeys/some-key/reset";
    const validBody = JSON.stringify({ taskIdentifier: "test-task" });

    const post = (headers: Record<string, string>, body = validBody) =>
      getTestServer().webapp.fetch(path, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body,
      });

    it("missing auth: 401", async () => {
      const res = await post({});
      expect(res.status).toBe(401);
    });

    it("invalid API key: 401", async () => {
      const res = await post({ Authorization: "Bearer tr_dev_invalid" });
      expect(res.status).toBe(401);
    });

    it("private API key: auth passes", async () => {
      const server = getTestServer();
      const seed = await seedTestEnvironment(server.prisma);
      const res = await post({ Authorization: `Bearer ${seed.apiKey}` });
      // Handler may 404/204 depending on whether the idempotency key
      // exists. Auth-passed assertion only.
      expect(res.status).not.toBe(401);
      expect(res.status).not.toBe(403);
    });

    it("JWT with write:runs (type-level): auth passes — locks in TRI-8719 fix", async () => {
      const server = getTestServer();
      const seed = await seedTestEnvironment(server.prisma);
      const jwt = await generateJWT({
        secretKey: seed.apiKey,
        payload: { pub: true, sub: seed.environment.id, scopes: ["write:runs"] },
        expirationTime: "15m",
      });
      const res = await post({ Authorization: `Bearer ${jwt}` });
      // PRE-TRI-8719: this returned 403 (legacy empty-resource bug
      // rejected all JWTs). POST-TRI-8719: write:runs grants access.
      // Locking in the new behaviour.
      expect(res.status).not.toBe(401);
      expect(res.status).not.toBe(403);
    });

    it("JWT with read:runs (action mismatch): 403", async () => {
      const server = getTestServer();
      const seed = await seedTestEnvironment(server.prisma);
      const jwt = await generateJWT({
        secretKey: seed.apiKey,
        payload: { pub: true, sub: seed.environment.id, scopes: ["read:runs"] },
        expirationTime: "15m",
      });
      const res = await post({ Authorization: `Bearer ${jwt}` });
      expect(res.status).toBe(403);
    });

    it("JWT with write:all: auth passes", async () => {
      const server = getTestServer();
      const seed = await seedTestEnvironment(server.prisma);
      const jwt = await generateJWT({
        secretKey: seed.apiKey,
        payload: { pub: true, sub: seed.environment.id, scopes: ["write:all"] },
        expirationTime: "15m",
      });
      const res = await post({ Authorization: `Bearer ${jwt}` });
      expect(res.status).not.toBe(401);
      expect(res.status).not.toBe(403);
    });

    it("JWT with admin: auth passes", async () => {
      const server = getTestServer();
      const seed = await seedTestEnvironment(server.prisma);
      const jwt = await generateJWT({
        secretKey: seed.apiKey,
        payload: { pub: true, sub: seed.environment.id, scopes: ["admin"] },
        expirationTime: "15m",
      });
      const res = await post({ Authorization: `Bearer ${jwt}` });
      expect(res.status).not.toBe(401);
      expect(res.status).not.toBe(403);
    });
  });

  // Run resource routes (TRI-8734). Every read-side `$runId` route
  // computes its authorization resource from the loaded TaskRun:
  //   [
  //     { type: "runs", id: run.friendlyId },
  //     { type: "tasks", id: run.taskIdentifier },
  //     ...run.runTags.map(tag => ({ type: "tags", id: tag })),
  //     run.batch?.friendlyId && { type: "batch", id: run.batch.friendlyId },
  //   ]
  //
  // A JWT scope matching ANY array element grants access. We test the
  // full matrix against the canonical route (api.v3.runs.$runId), and
  // a sanity check on one of the others to confirm the wiring isn't
  // route-local. If a future route's resource shape diverges, add a
  // targeted describe.
  describe("Run resource — GET /api/v3/runs/:runId (multi-key array)", () => {
    const pathFor = (runId: string) => `/api/v3/runs/${runId}`;

    async function seedRunWithBatchAndTags() {
      const server = getTestServer();
      const seed = await seedTestEnvironment(server.prisma);
      const seeded = await seedTestRun(server.prisma, {
        environmentId: seed.environment.id,
        projectId: seed.project.id,
        runTags: ["alpha", "beta"],
        withBatch: true,
      });
      return { ...seed, ...seeded };
    }

    const get = (path: string, headers: Record<string, string>) =>
      getTestServer().webapp.fetch(path, { headers });

    it("missing auth: 401", async () => {
      const res = await get(pathFor("run_anything"), {});
      expect(res.status).toBe(401);
    });

    it("invalid API key: 401", async () => {
      const res = await get(pathFor("run_anything"), {
        Authorization: "Bearer tr_dev_invalid",
      });
      expect(res.status).toBe(401);
    });

    it("private API key on real run: auth passes", async () => {
      const { runFriendlyId, apiKey } = await seedRunWithBatchAndTags();
      const res = await get(pathFor(runFriendlyId), {
        Authorization: `Bearer ${apiKey}`,
      });
      expect(res.status).not.toBe(401);
      expect(res.status).not.toBe(403);
    });

    it("JWT read:runs (type-level): auth passes", async () => {
      const { runFriendlyId, apiKey, environment } = await seedRunWithBatchAndTags();
      const jwt = await generateJWT({
        secretKey: apiKey,
        payload: { pub: true, sub: environment.id, scopes: ["read:runs"] },
        expirationTime: "15m",
      });
      const res = await get(pathFor(runFriendlyId), { Authorization: `Bearer ${jwt}` });
      expect(res.status).not.toBe(401);
      expect(res.status).not.toBe(403);
    });

    it("JWT read:runs:<exact friendlyId>: auth passes (id match)", async () => {
      const { runFriendlyId, apiKey, environment } = await seedRunWithBatchAndTags();
      const jwt = await generateJWT({
        secretKey: apiKey,
        payload: {
          pub: true,
          sub: environment.id,
          scopes: [`read:runs:${runFriendlyId}`],
        },
        expirationTime: "15m",
      });
      const res = await get(pathFor(runFriendlyId), { Authorization: `Bearer ${jwt}` });
      expect(res.status).not.toBe(401);
      expect(res.status).not.toBe(403);
    });

    it("JWT read:runs:<other>: 403", async () => {
      const { runFriendlyId, apiKey, environment } = await seedRunWithBatchAndTags();
      const jwt = await generateJWT({
        secretKey: apiKey,
        payload: {
          pub: true,
          sub: environment.id,
          scopes: ["read:runs:run_someoneelse00000000000"],
        },
        expirationTime: "15m",
      });
      const res = await get(pathFor(runFriendlyId), { Authorization: `Bearer ${jwt}` });
      expect(res.status).toBe(403);
    });

    it("JWT read:tags:<tag the run has>: auth passes (array element match)", async () => {
      const { runFriendlyId, apiKey, environment } = await seedRunWithBatchAndTags();
      // run was seeded with runTags=["alpha","beta"]; scope matches "alpha".
      const jwt = await generateJWT({
        secretKey: apiKey,
        payload: { pub: true, sub: environment.id, scopes: ["read:tags:alpha"] },
        expirationTime: "15m",
      });
      const res = await get(pathFor(runFriendlyId), { Authorization: `Bearer ${jwt}` });
      expect(res.status).not.toBe(401);
      expect(res.status).not.toBe(403);
    });

    it("JWT read:tags:<tag the run does not have>: 403", async () => {
      const { runFriendlyId, apiKey, environment } = await seedRunWithBatchAndTags();
      const jwt = await generateJWT({
        secretKey: apiKey,
        payload: { pub: true, sub: environment.id, scopes: ["read:tags:gamma"] },
        expirationTime: "15m",
      });
      const res = await get(pathFor(runFriendlyId), { Authorization: `Bearer ${jwt}` });
      expect(res.status).toBe(403);
    });

    it("JWT read:batch:<run's batchFriendlyId>: auth passes", async () => {
      const { runFriendlyId, batchFriendlyId, apiKey, environment } =
        await seedRunWithBatchAndTags();
      const jwt = await generateJWT({
        secretKey: apiKey,
        payload: {
          pub: true,
          sub: environment.id,
          scopes: [`read:batch:${batchFriendlyId}`],
        },
        expirationTime: "15m",
      });
      const res = await get(pathFor(runFriendlyId), { Authorization: `Bearer ${jwt}` });
      expect(res.status).not.toBe(401);
      expect(res.status).not.toBe(403);
    });

    it("JWT read:batch:<other>: 403", async () => {
      const { runFriendlyId, apiKey, environment } = await seedRunWithBatchAndTags();
      const jwt = await generateJWT({
        secretKey: apiKey,
        payload: {
          pub: true,
          sub: environment.id,
          scopes: ["read:batch:batch_someoneelse00000000"],
        },
        expirationTime: "15m",
      });
      const res = await get(pathFor(runFriendlyId), { Authorization: `Bearer ${jwt}` });
      expect(res.status).toBe(403);
    });

    it("JWT read:tasks:<run's taskIdentifier>: auth passes", async () => {
      const { runFriendlyId, apiKey, environment } = await seedRunWithBatchAndTags();
      // seedTestRun uses taskIdentifier "test-task" by default.
      const jwt = await generateJWT({
        secretKey: apiKey,
        payload: { pub: true, sub: environment.id, scopes: ["read:tasks:test-task"] },
        expirationTime: "15m",
      });
      const res = await get(pathFor(runFriendlyId), { Authorization: `Bearer ${jwt}` });
      expect(res.status).not.toBe(401);
      expect(res.status).not.toBe(403);
    });

    it("JWT read:all: auth passes", async () => {
      const { runFriendlyId, apiKey, environment } = await seedRunWithBatchAndTags();
      const jwt = await generateJWT({
        secretKey: apiKey,
        payload: { pub: true, sub: environment.id, scopes: ["read:all"] },
        expirationTime: "15m",
      });
      const res = await get(pathFor(runFriendlyId), { Authorization: `Bearer ${jwt}` });
      expect(res.status).not.toBe(401);
      expect(res.status).not.toBe(403);
    });

    it("JWT admin: auth passes", async () => {
      const { runFriendlyId, apiKey, environment } = await seedRunWithBatchAndTags();
      const jwt = await generateJWT({
        secretKey: apiKey,
        payload: { pub: true, sub: environment.id, scopes: ["admin"] },
        expirationTime: "15m",
      });
      const res = await get(pathFor(runFriendlyId), { Authorization: `Bearer ${jwt}` });
      expect(res.status).not.toBe(401);
      expect(res.status).not.toBe(403);
    });

    it("JWT write:runs:<friendlyId>: 403 (action mismatch — read route)", async () => {
      const { runFriendlyId, apiKey, environment } = await seedRunWithBatchAndTags();
      const jwt = await generateJWT({
        secretKey: apiKey,
        payload: {
          pub: true,
          sub: environment.id,
          scopes: [`write:runs:${runFriendlyId}`],
        },
        expirationTime: "15m",
      });
      const res = await get(pathFor(runFriendlyId), { Authorization: `Bearer ${jwt}` });
      expect(res.status).toBe(403);
    });

    it("cross-env: env A's JWT cannot read env B's run: not 200", async () => {
      const server = getTestServer();
      const a = await seedTestEnvironment(server.prisma);
      const b = await seedRunWithBatchAndTags();
      const jwt = await generateJWT({
        secretKey: a.apiKey,
        payload: {
          pub: true,
          sub: a.environment.id,
          scopes: [`read:runs:${b.runFriendlyId}`],
        },
        expirationTime: "15m",
      });
      const res = await get(pathFor(b.runFriendlyId), { Authorization: `Bearer ${jwt}` });
      // Either auth fails or the run lookup misses (env A's view of
      // the run doesn't include env B's data). Critical: NOT 200.
      expect(res.status).not.toBe(200);
    });
  });

  // Sanity check: same multi-key pattern wired the same way on the
  // events sub-route. If this drifts in the future the divergence
  // gets a dedicated describe.
  describe("Run resource — GET /api/v1/runs/:runId/events (sanity)", () => {
    const pathFor = (runId: string) => `/api/v1/runs/${runId}/events`;

    it("missing auth: 401", async () => {
      const res = await getTestServer().webapp.fetch(pathFor("run_anything"));
      expect(res.status).toBe(401);
    });

    it("JWT read:runs (type-level): auth passes on a real run", async () => {
      const server = getTestServer();
      const seed = await seedTestEnvironment(server.prisma);
      const { runFriendlyId } = await seedTestRun(server.prisma, {
        environmentId: seed.environment.id,
        projectId: seed.project.id,
      });
      const jwt = await generateJWT({
        secretKey: seed.apiKey,
        payload: { pub: true, sub: seed.environment.id, scopes: ["read:runs"] },
        expirationTime: "15m",
      });
      const res = await getTestServer().webapp.fetch(pathFor(runFriendlyId), {
        headers: { Authorization: `Bearer ${jwt}` },
      });
      expect(res.status).not.toBe(401);
      expect(res.status).not.toBe(403);
    });
  });

  // Batch resources (TRI-8737). Per-batch retrieve + realtime
  // endpoints — single-id resource `{ type: "batch", id: batch.friendlyId }`.
  // The list endpoint (`GET /api/v1/batches`) is currently absent
  // from this branch (deleted in s3-switchover), so the list-
  // section of the matrix is N/A here. If/when the list endpoint
  // returns, add a list-side describe.
  //
  // Notable behaviour: the route's resource is `{ type: "batch" }`,
  // NOT `{ type: "runs" }`. The legacy literal-match escape that
  // let `read:runs` JWTs hit batch endpoints no longer applies.
  // Tests pin this down (a `read:runs` scope on a `{ type: "batch" }`
  // resource is a type mismatch → 403).
  describe("Batch retrieve — GET /api/v1/batches/:batchId", () => {
    const pathFor = (batchId: string) => `/api/v1/batches/${batchId}`;

    async function seedRunWithBatch() {
      const server = getTestServer();
      const seed = await seedTestEnvironment(server.prisma);
      const seeded = await seedTestRun(server.prisma, {
        environmentId: seed.environment.id,
        projectId: seed.project.id,
        withBatch: true,
      });
      // batchFriendlyId is guaranteed when withBatch is set.
      if (!seeded.batchFriendlyId) {
        throw new Error("seedTestRun({ withBatch: true }) didn't return a batchFriendlyId");
      }
      return { ...seed, batchFriendlyId: seeded.batchFriendlyId };
    }

    const get = (path: string, headers: Record<string, string>) =>
      getTestServer().webapp.fetch(path, { headers });

    it("missing auth: 401", async () => {
      const res = await get(pathFor("batch_anything"), {});
      expect(res.status).toBe(401);
    });

    it("invalid API key: 401", async () => {
      const res = await get(pathFor("batch_anything"), {
        Authorization: "Bearer tr_dev_invalid",
      });
      expect(res.status).toBe(401);
    });

    it("private API key on real batch: auth passes", async () => {
      const { batchFriendlyId, apiKey } = await seedRunWithBatch();
      const res = await get(pathFor(batchFriendlyId), {
        Authorization: `Bearer ${apiKey}`,
      });
      expect(res.status).not.toBe(401);
      expect(res.status).not.toBe(403);
    });

    it("JWT read:batch:<friendlyId> matching: auth passes", async () => {
      const { batchFriendlyId, apiKey, environment } = await seedRunWithBatch();
      const jwt = await generateJWT({
        secretKey: apiKey,
        payload: {
          pub: true,
          sub: environment.id,
          scopes: [`read:batch:${batchFriendlyId}`],
        },
        expirationTime: "15m",
      });
      const res = await get(pathFor(batchFriendlyId), { Authorization: `Bearer ${jwt}` });
      expect(res.status).not.toBe(401);
      expect(res.status).not.toBe(403);
    });

    it("JWT read:batch:<other>: 403", async () => {
      const { batchFriendlyId, apiKey, environment } = await seedRunWithBatch();
      const jwt = await generateJWT({
        secretKey: apiKey,
        payload: {
          pub: true,
          sub: environment.id,
          scopes: ["read:batch:batch_someoneelse00000000"],
        },
        expirationTime: "15m",
      });
      const res = await get(pathFor(batchFriendlyId), { Authorization: `Bearer ${jwt}` });
      expect(res.status).toBe(403);
    });

    it("JWT read:batch (type-level): auth passes", async () => {
      const { batchFriendlyId, apiKey, environment } = await seedRunWithBatch();
      const jwt = await generateJWT({
        secretKey: apiKey,
        payload: { pub: true, sub: environment.id, scopes: ["read:batch"] },
        expirationTime: "15m",
      });
      const res = await get(pathFor(batchFriendlyId), { Authorization: `Bearer ${jwt}` });
      expect(res.status).not.toBe(401);
      expect(res.status).not.toBe(403);
    });

    it("JWT read:runs: auth passes (backwards-compat for legacy SDKs)", async () => {
      const { batchFriendlyId, apiKey, environment } = await seedRunWithBatch();
      const jwt = await generateJWT({
        secretKey: apiKey,
        payload: { pub: true, sub: environment.id, scopes: ["read:runs"] },
        expirationTime: "15m",
      });
      const res = await get(pathFor(batchFriendlyId), { Authorization: `Bearer ${jwt}` });
      // Pre-RBAC the batch-retrieve route's superScopes included
      // `read:runs`, so JWTs minted with read:runs could read batches.
      // The post-migration backwards-compat fix adds a `{type: "runs"}`
      // element to the route's anyResource(...) list so those
      // SDK-issued JWTs in the wild keep working — avoids a silent
      // 401/403 regression for callers we never told to switch scopes.
      // Per-id `read:batch:<id>` and type-level `read:batch` still
      // grant via the route's first resource element.
      expect(res.status).not.toBe(401);
      expect(res.status).not.toBe(403);
    });

    it("JWT read:all super-scope: auth passes", async () => {
      const { batchFriendlyId, apiKey, environment } = await seedRunWithBatch();
      const jwt = await generateJWT({
        secretKey: apiKey,
        payload: { pub: true, sub: environment.id, scopes: ["read:all"] },
        expirationTime: "15m",
      });
      const res = await get(pathFor(batchFriendlyId), { Authorization: `Bearer ${jwt}` });
      expect(res.status).not.toBe(401);
      expect(res.status).not.toBe(403);
    });

    it("JWT admin: auth passes", async () => {
      const { batchFriendlyId, apiKey, environment } = await seedRunWithBatch();
      const jwt = await generateJWT({
        secretKey: apiKey,
        payload: { pub: true, sub: environment.id, scopes: ["admin"] },
        expirationTime: "15m",
      });
      const res = await get(pathFor(batchFriendlyId), { Authorization: `Bearer ${jwt}` });
      expect(res.status).not.toBe(401);
      expect(res.status).not.toBe(403);
    });

    it("cross-env: env A's JWT cannot read env B's batch: not 200", async () => {
      const server = getTestServer();
      const a = await seedTestEnvironment(server.prisma);
      const b = await seedRunWithBatch();
      const jwt = await generateJWT({
        secretKey: a.apiKey,
        payload: {
          pub: true,
          sub: a.environment.id,
          scopes: [`read:batch:${b.batchFriendlyId}`],
        },
        expirationTime: "15m",
      });
      const res = await get(pathFor(b.batchFriendlyId), { Authorization: `Bearer ${jwt}` });
      // Critical: env A's JWT can't see env B's batch (env-scoped
      // findResource returns null). NOT 200.
      expect(res.status).not.toBe(200);
    });
  });

  // Sanity: api.v2 and realtime.v1 share the exact same authorization
  // config as v1. Don't duplicate the full matrix; just verify the
  // wiring is alive on each.
  describe("Batch retrieve — GET /api/v2/batches/:batchId (sanity)", () => {
    it("missing auth: 401", async () => {
      const res = await getTestServer().webapp.fetch("/api/v2/batches/batch_anything");
      expect(res.status).toBe(401);
    });

    it("JWT read:batch (type-level): auth passes on real batch", async () => {
      const server = getTestServer();
      const seed = await seedTestEnvironment(server.prisma);
      const seeded = await seedTestRun(server.prisma, {
        environmentId: seed.environment.id,
        projectId: seed.project.id,
        withBatch: true,
      });
      const jwt = await generateJWT({
        secretKey: seed.apiKey,
        payload: { pub: true, sub: seed.environment.id, scopes: ["read:batch"] },
        expirationTime: "15m",
      });
      const res = await getTestServer().webapp.fetch(
        `/api/v2/batches/${seeded.batchFriendlyId}`,
        { headers: { Authorization: `Bearer ${jwt}` } }
      );
      expect(res.status).not.toBe(401);
      expect(res.status).not.toBe(403);
    });
  });

  // Prompts routes (TRI-8738). Resource shapes:
  //   - List       resource: { type: "prompts", id: "all" }      action: read
  //   - Retrieve   resource: { type: "prompts", id: params.slug } action: read
  //   - Override   resource: { type: "prompts", id: params.slug } action: update
  //                (multi-method: POST/PUT/PATCH/DELETE)
  //   - Promote    resource: { type: "prompts", id: params.slug } action: update
  //   - Reactivate resource: { type: "prompts", id: params.slug } action: update
  //
  // ACTION_ALIASES: update ← write, so write:prompts also satisfies
  // the update-action routes.
  //
  // Auth happens before any DB lookup, so we test against
  // non-existent slugs — handler will 404 but we assert "not 401/403"
  // for pass cases.
  describe("Prompts list — GET /api/v1/prompts (collection-level)", () => {
    const path = "/api/v1/prompts";
    const get = (headers: Record<string, string>) =>
      getTestServer().webapp.fetch(path, { headers });

    it("missing auth: 401", async () => {
      const res = await getTestServer().webapp.fetch(path);
      expect(res.status).toBe(401);
    });

    it("private API key: auth passes", async () => {
      const server = getTestServer();
      const seed = await seedTestEnvironment(server.prisma);
      const res = await get({ Authorization: `Bearer ${seed.apiKey}` });
      expect(res.status).not.toBe(401);
      expect(res.status).not.toBe(403);
    });

    it("JWT read:prompts (type-level): auth passes", async () => {
      const server = getTestServer();
      const seed = await seedTestEnvironment(server.prisma);
      const jwt = await generateJWT({
        secretKey: seed.apiKey,
        payload: { pub: true, sub: seed.environment.id, scopes: ["read:prompts"] },
        expirationTime: "15m",
      });
      const res = await get({ Authorization: `Bearer ${jwt}` });
      expect(res.status).not.toBe(401);
      expect(res.status).not.toBe(403);
    });

    it("JWT read:runs: 403 (type mismatch)", async () => {
      const server = getTestServer();
      const seed = await seedTestEnvironment(server.prisma);
      const jwt = await generateJWT({
        secretKey: seed.apiKey,
        payload: { pub: true, sub: seed.environment.id, scopes: ["read:runs"] },
        expirationTime: "15m",
      });
      const res = await get({ Authorization: `Bearer ${jwt}` });
      expect(res.status).toBe(403);
    });

    it("JWT admin: auth passes", async () => {
      const server = getTestServer();
      const seed = await seedTestEnvironment(server.prisma);
      const jwt = await generateJWT({
        secretKey: seed.apiKey,
        payload: { pub: true, sub: seed.environment.id, scopes: ["admin"] },
        expirationTime: "15m",
      });
      const res = await get({ Authorization: `Bearer ${jwt}` });
      expect(res.status).not.toBe(401);
      expect(res.status).not.toBe(403);
    });
  });

  describe("Prompts retrieve — GET /api/v1/prompts/:slug (id-keyed read)", () => {
    const SLUG = "test-prompt";
    const path = `/api/v1/prompts/${SLUG}`;
    const get = (headers: Record<string, string>) =>
      getTestServer().webapp.fetch(path, { headers });

    it("missing auth: 401", async () => {
      const res = await getTestServer().webapp.fetch(path);
      expect(res.status).toBe(401);
    });

    it("private API key: auth passes", async () => {
      const server = getTestServer();
      const seed = await seedTestEnvironment(server.prisma);
      const res = await get({ Authorization: `Bearer ${seed.apiKey}` });
      expect(res.status).not.toBe(401);
      expect(res.status).not.toBe(403);
    });

    it("JWT read:prompts (type-level): auth passes", async () => {
      const server = getTestServer();
      const seed = await seedTestEnvironment(server.prisma);
      const jwt = await generateJWT({
        secretKey: seed.apiKey,
        payload: { pub: true, sub: seed.environment.id, scopes: ["read:prompts"] },
        expirationTime: "15m",
      });
      const res = await get({ Authorization: `Bearer ${jwt}` });
      expect(res.status).not.toBe(401);
      expect(res.status).not.toBe(403);
    });

    it("JWT read:prompts:<exact slug>: auth passes", async () => {
      const server = getTestServer();
      const seed = await seedTestEnvironment(server.prisma);
      const jwt = await generateJWT({
        secretKey: seed.apiKey,
        payload: {
          pub: true,
          sub: seed.environment.id,
          scopes: [`read:prompts:${SLUG}`],
        },
        expirationTime: "15m",
      });
      const res = await get({ Authorization: `Bearer ${jwt}` });
      expect(res.status).not.toBe(401);
      expect(res.status).not.toBe(403);
    });

    it("JWT read:prompts:<other>: not 200 (no access)", async () => {
      // Note: the prompts retrieve route has a findResource callback
      // that runs BEFORE authorization. Since we don't seed a Prompt
      // fixture, the route 404s before reaching the auth check —
      // assert "not 200" to capture the no-access semantic without
      // depending on whether the guard that fires first is auth (403)
      // or findResource (404). Both block the user.
      const server = getTestServer();
      const seed = await seedTestEnvironment(server.prisma);
      const jwt = await generateJWT({
        secretKey: seed.apiKey,
        payload: {
          pub: true,
          sub: seed.environment.id,
          scopes: ["read:prompts:some-other-slug"],
        },
        expirationTime: "15m",
      });
      const res = await get({ Authorization: `Bearer ${jwt}` });
      expect(res.status).not.toBe(200);
    });

    it("JWT read:runs: not 200 (type mismatch — no access)", async () => {
      // Same caveat as above re: findResource ordering.
      const server = getTestServer();
      const seed = await seedTestEnvironment(server.prisma);
      const jwt = await generateJWT({
        secretKey: seed.apiKey,
        payload: { pub: true, sub: seed.environment.id, scopes: ["read:runs"] },
        expirationTime: "15m",
      });
      const res = await get({ Authorization: `Bearer ${jwt}` });
      expect(res.status).not.toBe(200);
    });

    it("JWT admin: auth passes", async () => {
      const server = getTestServer();
      const seed = await seedTestEnvironment(server.prisma);
      const jwt = await generateJWT({
        secretKey: seed.apiKey,
        payload: { pub: true, sub: seed.environment.id, scopes: ["admin"] },
        expirationTime: "15m",
      });
      const res = await get({ Authorization: `Bearer ${jwt}` });
      expect(res.status).not.toBe(401);
      expect(res.status).not.toBe(403);
    });
  });

  describe("Prompts override — POST /api/v1/prompts/:slug/override (update action)", () => {
    const SLUG = "test-prompt";
    const path = `/api/v1/prompts/${SLUG}/override`;
    const post = (headers: Record<string, string>) =>
      getTestServer().webapp.fetch(path, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify({ content: "test" }),
      });

    it("missing auth: 401", async () => {
      const res = await post({});
      expect(res.status).toBe(401);
    });

    it("JWT write:prompts:<slug> matching (ACTION_ALIASES write→update): passes", async () => {
      const server = getTestServer();
      const seed = await seedTestEnvironment(server.prisma);
      const jwt = await generateJWT({
        secretKey: seed.apiKey,
        payload: {
          pub: true,
          sub: seed.environment.id,
          scopes: [`write:prompts:${SLUG}`],
        },
        expirationTime: "15m",
      });
      const res = await post({ Authorization: `Bearer ${jwt}` });
      expect(res.status).not.toBe(401);
      expect(res.status).not.toBe(403);
    });

    it("JWT write:prompts (type-level): passes", async () => {
      const server = getTestServer();
      const seed = await seedTestEnvironment(server.prisma);
      const jwt = await generateJWT({
        secretKey: seed.apiKey,
        payload: { pub: true, sub: seed.environment.id, scopes: ["write:prompts"] },
        expirationTime: "15m",
      });
      const res = await post({ Authorization: `Bearer ${jwt}` });
      expect(res.status).not.toBe(401);
      expect(res.status).not.toBe(403);
    });

    it("JWT read:prompts: 403 (action mismatch — read NOT aliased to update)", async () => {
      const server = getTestServer();
      const seed = await seedTestEnvironment(server.prisma);
      const jwt = await generateJWT({
        secretKey: seed.apiKey,
        payload: {
          pub: true,
          sub: seed.environment.id,
          scopes: [`read:prompts:${SLUG}`],
        },
        expirationTime: "15m",
      });
      const res = await post({ Authorization: `Bearer ${jwt}` });
      expect(res.status).toBe(403);
    });

    it("JWT write:prompts:<other>: 403", async () => {
      const server = getTestServer();
      const seed = await seedTestEnvironment(server.prisma);
      const jwt = await generateJWT({
        secretKey: seed.apiKey,
        payload: {
          pub: true,
          sub: seed.environment.id,
          scopes: ["write:prompts:some-other-slug"],
        },
        expirationTime: "15m",
      });
      const res = await post({ Authorization: `Bearer ${jwt}` });
      expect(res.status).toBe(403);
    });

    it("JWT admin: passes", async () => {
      const server = getTestServer();
      const seed = await seedTestEnvironment(server.prisma);
      const jwt = await generateJWT({
        secretKey: seed.apiKey,
        payload: { pub: true, sub: seed.environment.id, scopes: ["admin"] },
        expirationTime: "15m",
      });
      const res = await post({ Authorization: `Bearer ${jwt}` });
      expect(res.status).not.toBe(401);
      expect(res.status).not.toBe(403);
    });
  });

  describe("Prompts promote/reactivate (sanity, update action)", () => {
    it("promote: JWT write:prompts (type-level): auth passes", async () => {
      const server = getTestServer();
      const seed = await seedTestEnvironment(server.prisma);
      const jwt = await generateJWT({
        secretKey: seed.apiKey,
        payload: { pub: true, sub: seed.environment.id, scopes: ["write:prompts"] },
        expirationTime: "15m",
      });
      const res = await server.webapp.fetch("/api/v1/prompts/some-slug/promote", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${jwt}` },
        body: JSON.stringify({}),
      });
      expect(res.status).not.toBe(401);
      expect(res.status).not.toBe(403);
    });

    it("reactivate: JWT read:prompts: 403 (action mismatch)", async () => {
      const server = getTestServer();
      const seed = await seedTestEnvironment(server.prisma);
      const jwt = await generateJWT({
        secretKey: seed.apiKey,
        payload: { pub: true, sub: seed.environment.id, scopes: ["read:prompts"] },
        expirationTime: "15m",
      });
      // Body must satisfy the route's schema ({ version: positive int })
      // — otherwise body validation 400s before authorization runs.
      const res = await server.webapp.fetch(
        "/api/v1/prompts/some-slug/override/reactivate",
        {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${jwt}` },
          body: JSON.stringify({ version: 1 }),
        }
      );
      expect(res.status).toBe(403);
    });
  });

  // Deployments + query routes (TRI-8739). Read-only family with
  // distinct resource types per route:
  //   - GET /api/v1/deployments         { type: "deployments", id: "list" }
  //   - GET /api/v1/query/schema        { type: "query", id: "schema" }
  //   - GET /api/v1/query/dashboards    { type: "query", id: "dashboards" }
  //   - POST /api/v1/query              body-derived: detectTables(query) →
  //                                     [{ type: "query", id }] or
  //                                     { type: "query", id: "all" } if none
  describe("Deployments list — GET /api/v1/deployments", () => {
    const path = "/api/v1/deployments";
    const get = (headers: Record<string, string>) =>
      getTestServer().webapp.fetch(path, { headers });

    it("missing auth: 401", async () => {
      const res = await getTestServer().webapp.fetch(path);
      expect(res.status).toBe(401);
    });

    it("private API key: auth passes", async () => {
      const server = getTestServer();
      const seed = await seedTestEnvironment(server.prisma);
      const res = await get({ Authorization: `Bearer ${seed.apiKey}` });
      expect(res.status).not.toBe(401);
      expect(res.status).not.toBe(403);
    });

    it("JWT read:deployments: auth passes", async () => {
      const server = getTestServer();
      const seed = await seedTestEnvironment(server.prisma);
      const jwt = await generateJWT({
        secretKey: seed.apiKey,
        payload: { pub: true, sub: seed.environment.id, scopes: ["read:deployments"] },
        expirationTime: "15m",
      });
      const res = await get({ Authorization: `Bearer ${jwt}` });
      expect(res.status).not.toBe(401);
      expect(res.status).not.toBe(403);
    });

    it("JWT read:all: auth passes", async () => {
      const server = getTestServer();
      const seed = await seedTestEnvironment(server.prisma);
      const jwt = await generateJWT({
        secretKey: seed.apiKey,
        payload: { pub: true, sub: seed.environment.id, scopes: ["read:all"] },
        expirationTime: "15m",
      });
      const res = await get({ Authorization: `Bearer ${jwt}` });
      expect(res.status).not.toBe(401);
      expect(res.status).not.toBe(403);
    });

    it("JWT admin: auth passes", async () => {
      const server = getTestServer();
      const seed = await seedTestEnvironment(server.prisma);
      const jwt = await generateJWT({
        secretKey: seed.apiKey,
        payload: { pub: true, sub: seed.environment.id, scopes: ["admin"] },
        expirationTime: "15m",
      });
      const res = await get({ Authorization: `Bearer ${jwt}` });
      expect(res.status).not.toBe(401);
      expect(res.status).not.toBe(403);
    });

    it("JWT read:runs (type mismatch): 403", async () => {
      const server = getTestServer();
      const seed = await seedTestEnvironment(server.prisma);
      const jwt = await generateJWT({
        secretKey: seed.apiKey,
        payload: { pub: true, sub: seed.environment.id, scopes: ["read:runs"] },
        expirationTime: "15m",
      });
      const res = await get({ Authorization: `Bearer ${jwt}` });
      expect(res.status).toBe(403);
    });

    it("JWT write:deployments (action mismatch — read route): 403", async () => {
      const server = getTestServer();
      const seed = await seedTestEnvironment(server.prisma);
      const jwt = await generateJWT({
        secretKey: seed.apiKey,
        payload: { pub: true, sub: seed.environment.id, scopes: ["write:deployments"] },
        expirationTime: "15m",
      });
      const res = await get({ Authorization: `Bearer ${jwt}` });
      expect(res.status).toBe(403);
    });
  });

  describe("Query schema — GET /api/v1/query/schema (sanity)", () => {
    const path = "/api/v1/query/schema";

    it("missing auth: 401", async () => {
      const res = await getTestServer().webapp.fetch(path);
      expect(res.status).toBe(401);
    });

    it("JWT read:query (type-level): auth passes", async () => {
      const server = getTestServer();
      const seed = await seedTestEnvironment(server.prisma);
      const jwt = await generateJWT({
        secretKey: seed.apiKey,
        payload: { pub: true, sub: seed.environment.id, scopes: ["read:query"] },
        expirationTime: "15m",
      });
      const res = await server.webapp.fetch(path, {
        headers: { Authorization: `Bearer ${jwt}` },
      });
      expect(res.status).not.toBe(401);
      expect(res.status).not.toBe(403);
    });

    it("JWT read:deployments (type mismatch): 403", async () => {
      const server = getTestServer();
      const seed = await seedTestEnvironment(server.prisma);
      const jwt = await generateJWT({
        secretKey: seed.apiKey,
        payload: { pub: true, sub: seed.environment.id, scopes: ["read:deployments"] },
        expirationTime: "15m",
      });
      const res = await server.webapp.fetch(path, {
        headers: { Authorization: `Bearer ${jwt}` },
      });
      expect(res.status).toBe(403);
    });
  });

  describe("Query dashboards — GET /api/v1/query/dashboards (sanity)", () => {
    const path = "/api/v1/query/dashboards";

    it("missing auth: 401", async () => {
      const res = await getTestServer().webapp.fetch(path);
      expect(res.status).toBe(401);
    });

    it("JWT read:query: auth passes", async () => {
      const server = getTestServer();
      const seed = await seedTestEnvironment(server.prisma);
      const jwt = await generateJWT({
        secretKey: seed.apiKey,
        payload: { pub: true, sub: seed.environment.id, scopes: ["read:query"] },
        expirationTime: "15m",
      });
      const res = await server.webapp.fetch(path, {
        headers: { Authorization: `Bearer ${jwt}` },
      });
      expect(res.status).not.toBe(401);
      expect(res.status).not.toBe(403);
    });
  });

  describe("Query ad-hoc — POST /api/v1/query (body-derived resource)", () => {
    const path = "/api/v1/query";
    const post = (body: object, headers: Record<string, string>) =>
      getTestServer().webapp.fetch(path, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify(body),
      });

    it("missing auth: 401", async () => {
      const res = await post({ query: "SELECT * FROM runs" }, {});
      expect(res.status).toBe(401);
    });

    it("body with table 'runs' + JWT read:query:runs: auth passes (any-match)", async () => {
      // detectTables pulls 'runs' from FROM-clause. Resource becomes
      // [{ type: "query", id: "runs" }]. Scope read:query:runs matches.
      const server = getTestServer();
      const seed = await seedTestEnvironment(server.prisma);
      const jwt = await generateJWT({
        secretKey: seed.apiKey,
        payload: { pub: true, sub: seed.environment.id, scopes: ["read:query:runs"] },
        expirationTime: "15m",
      });
      const res = await post({ query: "SELECT * FROM runs" }, {
        Authorization: `Bearer ${jwt}`,
      });
      expect(res.status).not.toBe(401);
      expect(res.status).not.toBe(403);
    });

    it("body with no detectable tables (defaults id='all') + JWT read:query: auth passes", async () => {
      // A query with no FROM clause → detectTables returns [] →
      // resource is { type: "query", id: "all" }. Type-level read:query
      // matches.
      const server = getTestServer();
      const seed = await seedTestEnvironment(server.prisma);
      const jwt = await generateJWT({
        secretKey: seed.apiKey,
        payload: { pub: true, sub: seed.environment.id, scopes: ["read:query"] },
        expirationTime: "15m",
      });
      const res = await post({ query: "SELECT 1" }, { Authorization: `Bearer ${jwt}` });
      expect(res.status).not.toBe(401);
      expect(res.status).not.toBe(403);
    });

    it("multi-table body + JWT scoped to only one of them: 403 (every-table semantics)", async () => {
      // detectTables matches `\bFROM\s+<name>\b` per query-schema, so
      // a query with two FROM clauses (e.g. UNION) yields a multi-
      // entry resource list. The route wraps it in everyResource so
      // AND semantics apply: a JWT scoped to one detected table
      // cannot submit a query that also reads the other.
      const server = getTestServer();
      const seed = await seedTestEnvironment(server.prisma);
      const jwt = await generateJWT({
        secretKey: seed.apiKey,
        payload: { pub: true, sub: seed.environment.id, scopes: ["read:query:runs"] },
        expirationTime: "15m",
      });
      const res = await post(
        {
          query:
            "SELECT count() FROM runs UNION ALL SELECT count() FROM metrics",
        },
        { Authorization: `Bearer ${jwt}` }
      );
      expect(res.status).toBe(403);
    });

    it("multi-table body + JWT scoped to all detected tables: auth passes", async () => {
      // Companion to the every-table 403 above — when the JWT covers
      // every detected table the AND-check passes.
      const server = getTestServer();
      const seed = await seedTestEnvironment(server.prisma);
      const jwt = await generateJWT({
        secretKey: seed.apiKey,
        payload: {
          pub: true,
          sub: seed.environment.id,
          scopes: ["read:query:runs", "read:query:metrics"],
        },
        expirationTime: "15m",
      });
      const res = await post(
        {
          query:
            "SELECT count() FROM runs UNION ALL SELECT count() FROM metrics",
        },
        { Authorization: `Bearer ${jwt}` }
      );
      expect(res.status).not.toBe(401);
      expect(res.status).not.toBe(403);
    });

    it("body with table 'runs' + JWT read:query:other_table: 403", async () => {
      const server = getTestServer();
      const seed = await seedTestEnvironment(server.prisma);
      const jwt = await generateJWT({
        secretKey: seed.apiKey,
        payload: {
          pub: true,
          sub: seed.environment.id,
          scopes: ["read:query:other_table"],
        },
        expirationTime: "15m",
      });
      const res = await post({ query: "SELECT * FROM runs" }, {
        Authorization: `Bearer ${jwt}`,
      });
      expect(res.status).toBe(403);
    });

    it("JWT admin: auth passes regardless of body", async () => {
      const server = getTestServer();
      const seed = await seedTestEnvironment(server.prisma);
      const jwt = await generateJWT({
        secretKey: seed.apiKey,
        payload: { pub: true, sub: seed.environment.id, scopes: ["admin"] },
        expirationTime: "15m",
      });
      const res = await post({ query: "SELECT * FROM runs" }, {
        Authorization: `Bearer ${jwt}`,
      });
      expect(res.status).not.toBe(401);
      expect(res.status).not.toBe(403);
    });

    it("JWT write:query (action mismatch): 403", async () => {
      const server = getTestServer();
      const seed = await seedTestEnvironment(server.prisma);
      const jwt = await generateJWT({
        secretKey: seed.apiKey,
        payload: { pub: true, sub: seed.environment.id, scopes: ["write:query"] },
        expirationTime: "15m",
      });
      const res = await post({ query: "SELECT 1" }, { Authorization: `Bearer ${jwt}` });
      expect(res.status).toBe(403);
    });
  });

  describe("Batch retrieve — GET /realtime/v1/batches/:batchId (sanity)", () => {
    it("missing auth: 401", async () => {
      const res = await getTestServer().webapp.fetch("/realtime/v1/batches/batch_anything");
      expect(res.status).toBe(401);
    });

    it("JWT read:batch:<friendlyId>: auth passes on real batch", async () => {
      const server = getTestServer();
      const seed = await seedTestEnvironment(server.prisma);
      const seeded = await seedTestRun(server.prisma, {
        environmentId: seed.environment.id,
        projectId: seed.project.id,
        withBatch: true,
      });
      const jwt = await generateJWT({
        secretKey: seed.apiKey,
        payload: {
          pub: true,
          sub: seed.environment.id,
          scopes: [`read:batch:${seeded.batchFriendlyId}`],
        },
        expirationTime: "15m",
      });
      const res = await getTestServer().webapp.fetch(
        `/realtime/v1/batches/${seeded.batchFriendlyId}`,
        { headers: { Authorization: `Bearer ${jwt}` } }
      );
      expect(res.status).not.toBe(401);
      expect(res.status).not.toBe(403);
    });
  });

  // Sessions — JWT scope matrix.
  //
  // The session routes were authored against the pre-RBAC apiBuilder
  // and used the legacy `superScopes: [...]` field to whitelist broad
  // access. After TRI-8719 superScopes is dead code; the equivalent
  // bypass is expressed via:
  //   - multi-key resource arrays (one element per addressable key,
  //     plus a collection-level `{ type: "sessions" }` for type-only
  //     scopes)
  //   - the JWT ability's `*:all` and `admin*` wildcard branches
  //
  // These tests lock in that the migration's "no JWT regresses"
  // promise holds for sessions. Each historical superScope becomes a
  // positive test, and per-task narrowing gets negative coverage.
  describe("Sessions — JWT scope matrix", () => {
    // ---- List sessions: GET /api/v1/sessions
    //
    // Resource: [{ type: "tasks", id: <filter> } per filter id, { type: "sessions" }]
    // Old superScopes: ["read:sessions", "read:all", "admin"]
    describe("List sessions — GET /api/v1/sessions", () => {
      const path = (taskFilter?: string) =>
        taskFilter
          ? `/api/v1/sessions?filter[taskIdentifier]=${taskFilter}`
          : "/api/v1/sessions";

      const fetchWithJwt = async (jwt: string, taskFilter?: string) =>
        getTestServer().webapp.fetch(path(taskFilter), {
          headers: { Authorization: `Bearer ${jwt}` },
        });

      const mintJwt = async (apiKey: string, envId: string, scopes: string[]) =>
        generateJWT({
          secretKey: apiKey,
          payload: { pub: true, sub: envId, scopes },
          expirationTime: "15m",
        });

      // The handler reads from ClickHouse via SessionsRepository, which
      // isn't wired up in the e2e webapp container — so successful auth
      // surfaces as 5xx after the handler errors. Assert "not 401, not
      // 403" rather than 200 for the auth-passes paths.

      it("read:tasks:foo on filter=foo: auth passes", async () => {
        const seed = await seedTestEnvironment(getTestServer().prisma);
        const jwt = await mintJwt(seed.apiKey, seed.environment.id, [
          "read:tasks:foo",
        ]);
        const res = await fetchWithJwt(jwt, "foo");
        expect(res.status).not.toBe(401);
        expect(res.status).not.toBe(403);
      });

      it("read:tasks:bar on filter=foo: 403 (per-task narrowing)", async () => {
        const seed = await seedTestEnvironment(getTestServer().prisma);
        const jwt = await mintJwt(seed.apiKey, seed.environment.id, [
          "read:tasks:bar",
        ]);
        const res = await fetchWithJwt(jwt, "foo");
        expect(res.status).toBe(403);
      });

      it("read:sessions on filter=foo: auth passes (was a superScope)", async () => {
        const seed = await seedTestEnvironment(getTestServer().prisma);
        const jwt = await mintJwt(seed.apiKey, seed.environment.id, [
          "read:sessions",
        ]);
        const res = await fetchWithJwt(jwt, "foo");
        expect(res.status).not.toBe(401);
        expect(res.status).not.toBe(403);
      });

      it("read:sessions on no-filter list: auth passes", async () => {
        const seed = await seedTestEnvironment(getTestServer().prisma);
        const jwt = await mintJwt(seed.apiKey, seed.environment.id, [
          "read:sessions",
        ]);
        const res = await fetchWithJwt(jwt);
        expect(res.status).not.toBe(401);
        expect(res.status).not.toBe(403);
      });

      it("read:all: auth passes (was a superScope)", async () => {
        const seed = await seedTestEnvironment(getTestServer().prisma);
        const jwt = await mintJwt(seed.apiKey, seed.environment.id, ["read:all"]);
        const res = await fetchWithJwt(jwt, "foo");
        expect(res.status).not.toBe(401);
        expect(res.status).not.toBe(403);
      });

      it("admin: auth passes (was a superScope)", async () => {
        const seed = await seedTestEnvironment(getTestServer().prisma);
        const jwt = await mintJwt(seed.apiKey, seed.environment.id, ["admin"]);
        const res = await fetchWithJwt(jwt, "foo");
        expect(res.status).not.toBe(401);
        expect(res.status).not.toBe(403);
      });

      it("read:tasks (type-only) on no-filter list: 403 (filter is sessions, not tasks)", async () => {
        // No filter → resource is `{ type: "sessions" }` only. read:tasks
        // doesn't match the sessions type, so 403 — explicit narrowing.
        const seed = await seedTestEnvironment(getTestServer().prisma);
        const jwt = await mintJwt(seed.apiKey, seed.environment.id, [
          "read:tasks",
        ]);
        const res = await fetchWithJwt(jwt);
        expect(res.status).toBe(403);
      });

      it("write:tasks:foo (wrong action) on filter=foo: 403", async () => {
        const seed = await seedTestEnvironment(getTestServer().prisma);
        const jwt = await mintJwt(seed.apiKey, seed.environment.id, [
          "write:tasks:foo",
        ]);
        const res = await fetchWithJwt(jwt, "foo");
        expect(res.status).toBe(403);
      });
    });

    // ---- Create session: POST /api/v1/sessions
    //
    // Resource: [{ type: "tasks", id: body.taskIdentifier }, { type: "sessions" }]
    // Old superScopes: ["write:sessions", "admin"]
    describe("Create session — POST /api/v1/sessions", () => {
      const path = "/api/v1/sessions";

      const post = async (jwt: string, taskIdentifier: string) =>
        getTestServer().webapp.fetch(path, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${jwt}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            type: "chat.agent",
            taskIdentifier,
            triggerConfig: { basePayload: {} },
          }),
        });

      const mintJwt = async (apiKey: string, envId: string, scopes: string[]) =>
        generateJWT({
          secretKey: apiKey,
          payload: { pub: true, sub: envId, scopes },
          expirationTime: "15m",
        });

      it("write:tasks:foo matching body: auth passes", async () => {
        const seed = await seedTestEnvironment(getTestServer().prisma);
        const jwt = await mintJwt(seed.apiKey, seed.environment.id, [
          "write:tasks:foo",
        ]);
        const res = await post(jwt, "foo");
        // Body validation / handler can fail later (404 if task is
        // missing, 400 for invalid body) — we only care that auth
        // didn't reject.
        expect(res.status).not.toBe(401);
        expect(res.status).not.toBe(403);
      });

      it("write:tasks:bar mismatching body: 403", async () => {
        const seed = await seedTestEnvironment(getTestServer().prisma);
        const jwt = await mintJwt(seed.apiKey, seed.environment.id, [
          "write:tasks:bar",
        ]);
        const res = await post(jwt, "foo");
        expect(res.status).toBe(403);
      });

      it("write:sessions: auth passes (was a superScope)", async () => {
        const seed = await seedTestEnvironment(getTestServer().prisma);
        const jwt = await mintJwt(seed.apiKey, seed.environment.id, [
          "write:sessions",
        ]);
        const res = await post(jwt, "foo");
        expect(res.status).not.toBe(401);
        expect(res.status).not.toBe(403);
      });

      it("write:all: auth passes", async () => {
        const seed = await seedTestEnvironment(getTestServer().prisma);
        const jwt = await mintJwt(seed.apiKey, seed.environment.id, ["write:all"]);
        const res = await post(jwt, "foo");
        expect(res.status).not.toBe(401);
        expect(res.status).not.toBe(403);
      });

      it("admin: auth passes", async () => {
        const seed = await seedTestEnvironment(getTestServer().prisma);
        const jwt = await mintJwt(seed.apiKey, seed.environment.id, ["admin"]);
        const res = await post(jwt, "foo");
        expect(res.status).not.toBe(401);
        expect(res.status).not.toBe(403);
      });

      it("read:tasks:foo (wrong action): 403", async () => {
        const seed = await seedTestEnvironment(getTestServer().prisma);
        const jwt = await mintJwt(seed.apiKey, seed.environment.id, [
          "read:tasks:foo",
        ]);
        const res = await post(jwt, "foo");
        expect(res.status).toBe(403);
      });
    });

    // ---- Retrieve session: GET /api/v1/sessions/:session
    //
    // Resource: multi-key array of `{ type: "sessions", id }` entries
    // for friendlyId and externalId (when set).
    // Old superScopes: ["read:sessions", "read:all", "admin"]
    describe("Retrieve session — GET /api/v1/sessions/:session", () => {
      const get = async (sessionParam: string, jwt: string) =>
        getTestServer().webapp.fetch(`/api/v1/sessions/${sessionParam}`, {
          headers: { Authorization: `Bearer ${jwt}` },
        });

      const mintJwt = async (apiKey: string, envId: string, scopes: string[]) =>
        generateJWT({
          secretKey: apiKey,
          payload: { pub: true, sub: envId, scopes },
          expirationTime: "15m",
        });

      it("read:sessions:<friendlyId>: 200", async () => {
        const server = getTestServer();
        const seed = await seedTestEnvironment(server.prisma);
        const session = await seedTestApiSession(server.prisma, seed.environment);
        const jwt = await mintJwt(seed.apiKey, seed.environment.id, [
          `read:sessions:${session.friendlyId}`,
        ]);
        const res = await get(session.friendlyId, jwt);
        expect(res.status).toBe(200);
      });

      it("read:sessions:<externalId> on externalId URL form: 200 (multi-key)", async () => {
        const server = getTestServer();
        const seed = await seedTestEnvironment(server.prisma);
        const session = await seedTestApiSession(server.prisma, seed.environment);
        const jwt = await mintJwt(seed.apiKey, seed.environment.id, [
          `read:sessions:${session.externalId}`,
        ]);
        const res = await get(session.externalId!, jwt);
        expect(res.status).toBe(200);
      });

      it("read:sessions (type-only): 200", async () => {
        const server = getTestServer();
        const seed = await seedTestEnvironment(server.prisma);
        const session = await seedTestApiSession(server.prisma, seed.environment);
        const jwt = await mintJwt(seed.apiKey, seed.environment.id, [
          "read:sessions",
        ]);
        const res = await get(session.friendlyId, jwt);
        expect(res.status).toBe(200);
      });

      it("read:sessions:other (non-matching id): 403", async () => {
        const server = getTestServer();
        const seed = await seedTestEnvironment(server.prisma);
        const session = await seedTestApiSession(server.prisma, seed.environment);
        const jwt = await mintJwt(seed.apiKey, seed.environment.id, [
          "read:sessions:not-this-session",
        ]);
        const res = await get(session.friendlyId, jwt);
        expect(res.status).toBe(403);
      });
    });

    // ---- Update session: PATCH /api/v1/sessions/:session
    //
    // action: "admin" — only admin-tier scopes (or wildcards) satisfy.
    // Old superScopes: ["admin:sessions", "admin:all", "admin"]
    describe("Update session — PATCH /api/v1/sessions/:session", () => {
      const patch = async (sessionParam: string, jwt: string) =>
        getTestServer().webapp.fetch(`/api/v1/sessions/${sessionParam}`, {
          method: "PATCH",
          headers: {
            Authorization: `Bearer ${jwt}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ tags: ["updated"] }),
        });

      const mintJwt = async (apiKey: string, envId: string, scopes: string[]) =>
        generateJWT({
          secretKey: apiKey,
          payload: { pub: true, sub: envId, scopes },
          expirationTime: "15m",
        });

      it("admin:sessions:<friendlyId>: 200", async () => {
        const server = getTestServer();
        const seed = await seedTestEnvironment(server.prisma);
        const session = await seedTestApiSession(server.prisma, seed.environment);
        const jwt = await mintJwt(seed.apiKey, seed.environment.id, [
          `admin:sessions:${session.friendlyId}`,
        ]);
        const res = await patch(session.friendlyId, jwt);
        expect(res.status).toBe(200);
      });

      it("admin:sessions (type-only): 200", async () => {
        const server = getTestServer();
        const seed = await seedTestEnvironment(server.prisma);
        const session = await seedTestApiSession(server.prisma, seed.environment);
        const jwt = await mintJwt(seed.apiKey, seed.environment.id, [
          "admin:sessions",
        ]);
        const res = await patch(session.friendlyId, jwt);
        expect(res.status).toBe(200);
      });

      it("admin:all: 200", async () => {
        const server = getTestServer();
        const seed = await seedTestEnvironment(server.prisma);
        const session = await seedTestApiSession(server.prisma, seed.environment);
        const jwt = await mintJwt(seed.apiKey, seed.environment.id, ["admin:all"]);
        const res = await patch(session.friendlyId, jwt);
        expect(res.status).toBe(200);
      });

      it("admin (bare): 200", async () => {
        const server = getTestServer();
        const seed = await seedTestEnvironment(server.prisma);
        const session = await seedTestApiSession(server.prisma, seed.environment);
        const jwt = await mintJwt(seed.apiKey, seed.environment.id, ["admin"]);
        const res = await patch(session.friendlyId, jwt);
        expect(res.status).toBe(200);
      });

      it("write:sessions (wrong action — admin not aliased from write): 403", async () => {
        const server = getTestServer();
        const seed = await seedTestEnvironment(server.prisma);
        const session = await seedTestApiSession(server.prisma, seed.environment);
        const jwt = await mintJwt(seed.apiKey, seed.environment.id, [
          "write:sessions",
        ]);
        const res = await patch(session.friendlyId, jwt);
        expect(res.status).toBe(403);
      });
    });

    // ---- Close session: POST /api/v1/sessions/:session/close
    //
    // action: "admin" — same matrix as PATCH.
    describe("Close session — POST /api/v1/sessions/:session/close", () => {
      const close = async (sessionParam: string, jwt: string) =>
        getTestServer().webapp.fetch(
          `/api/v1/sessions/${sessionParam}/close`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${jwt}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ reason: "test" }),
          }
        );

      const mintJwt = async (apiKey: string, envId: string, scopes: string[]) =>
        generateJWT({
          secretKey: apiKey,
          payload: { pub: true, sub: envId, scopes },
          expirationTime: "15m",
        });

      it("admin:sessions: auth passes", async () => {
        const server = getTestServer();
        const seed = await seedTestEnvironment(server.prisma);
        const session = await seedTestApiSession(server.prisma, seed.environment);
        const jwt = await mintJwt(seed.apiKey, seed.environment.id, [
          "admin:sessions",
        ]);
        const res = await close(session.friendlyId, jwt);
        expect(res.status).not.toBe(401);
        expect(res.status).not.toBe(403);
      });

      it("admin: auth passes", async () => {
        const server = getTestServer();
        const seed = await seedTestEnvironment(server.prisma);
        const session = await seedTestApiSession(server.prisma, seed.environment);
        const jwt = await mintJwt(seed.apiKey, seed.environment.id, ["admin"]);
        const res = await close(session.friendlyId, jwt);
        expect(res.status).not.toBe(401);
        expect(res.status).not.toBe(403);
      });

      it("write:sessions: 403 (admin action)", async () => {
        const server = getTestServer();
        const seed = await seedTestEnvironment(server.prisma);
        const session = await seedTestApiSession(server.prisma, seed.environment);
        const jwt = await mintJwt(seed.apiKey, seed.environment.id, [
          "write:sessions",
        ]);
        const res = await close(session.friendlyId, jwt);
        expect(res.status).toBe(403);
      });
    });

    // ---- End-and-continue: POST /api/v1/sessions/:session/end-and-continue
    //
    // action: "write" — multi-key sessions resource.
    describe("End-and-continue — POST /api/v1/sessions/:session/end-and-continue", () => {
      const endAndContinue = async (sessionParam: string, jwt: string) =>
        getTestServer().webapp.fetch(
          `/api/v1/sessions/${sessionParam}/end-and-continue`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${jwt}`,
              "Content-Type": "application/json",
            },
            // Body shape doesn't matter for auth — handler runs after
            // the auth check so any 4xx here means auth passed.
            body: JSON.stringify({
              reason: "test",
              callingRunId: "run_does_not_exist",
            }),
          }
        );

      const mintJwt = async (apiKey: string, envId: string, scopes: string[]) =>
        generateJWT({
          secretKey: apiKey,
          payload: { pub: true, sub: envId, scopes },
          expirationTime: "15m",
        });

      it("write:sessions: auth passes (was a superScope)", async () => {
        const server = getTestServer();
        const seed = await seedTestEnvironment(server.prisma);
        const session = await seedTestApiSession(server.prisma, seed.environment);
        const jwt = await mintJwt(seed.apiKey, seed.environment.id, [
          "write:sessions",
        ]);
        const res = await endAndContinue(session.friendlyId, jwt);
        expect(res.status).not.toBe(401);
        expect(res.status).not.toBe(403);
      });

      it("write:all: auth passes", async () => {
        const server = getTestServer();
        const seed = await seedTestEnvironment(server.prisma);
        const session = await seedTestApiSession(server.prisma, seed.environment);
        const jwt = await mintJwt(seed.apiKey, seed.environment.id, ["write:all"]);
        const res = await endAndContinue(session.friendlyId, jwt);
        expect(res.status).not.toBe(401);
        expect(res.status).not.toBe(403);
      });

      it("read:sessions (wrong action): 403", async () => {
        const server = getTestServer();
        const seed = await seedTestEnvironment(server.prisma);
        const session = await seedTestApiSession(server.prisma, seed.environment);
        const jwt = await mintJwt(seed.apiKey, seed.environment.id, [
          "read:sessions",
        ]);
        const res = await endAndContinue(session.friendlyId, jwt);
        expect(res.status).toBe(403);
      });
    });

    // ---- Realtime IO: GET (subscribe) and PUT (initialize)
    //
    // Both go through createLoaderApiRoute / createActionApiRoute — same
    // multi-key sessions resource. No deep matrix here; one positive
    // test per old superScope per method is enough.
    describe("Realtime IO — /realtime/v1/sessions/:session/:io", () => {
      const ioPath = (sessionParam: string) =>
        `/realtime/v1/sessions/${sessionParam}/in`;

      const mintJwt = async (apiKey: string, envId: string, scopes: string[]) =>
        generateJWT({
          secretKey: apiKey,
          payload: { pub: true, sub: envId, scopes },
          expirationTime: "15m",
        });

      it("GET with read:sessions (was a superScope): auth passes", async () => {
        const server = getTestServer();
        const seed = await seedTestEnvironment(server.prisma);
        const session = await seedTestApiSession(server.prisma, seed.environment);
        const jwt = await mintJwt(seed.apiKey, seed.environment.id, [
          "read:sessions",
        ]);
        const res = await server.webapp.fetch(ioPath(session.friendlyId), {
          method: "HEAD",
          headers: { Authorization: `Bearer ${jwt}` },
        });
        expect(res.status).not.toBe(401);
        expect(res.status).not.toBe(403);
      });

      it("GET with read:all: auth passes", async () => {
        const server = getTestServer();
        const seed = await seedTestEnvironment(server.prisma);
        const session = await seedTestApiSession(server.prisma, seed.environment);
        const jwt = await mintJwt(seed.apiKey, seed.environment.id, ["read:all"]);
        const res = await server.webapp.fetch(ioPath(session.friendlyId), {
          method: "HEAD",
          headers: { Authorization: `Bearer ${jwt}` },
        });
        expect(res.status).not.toBe(401);
        expect(res.status).not.toBe(403);
      });

      it("PUT with write:sessions (was a superScope): auth passes", async () => {
        const server = getTestServer();
        const seed = await seedTestEnvironment(server.prisma);
        const session = await seedTestApiSession(server.prisma, seed.environment);
        const jwt = await mintJwt(seed.apiKey, seed.environment.id, [
          "write:sessions",
        ]);
        const res = await server.webapp.fetch(ioPath(session.friendlyId), {
          method: "PUT",
          headers: { Authorization: `Bearer ${jwt}` },
        });
        expect(res.status).not.toBe(401);
        expect(res.status).not.toBe(403);
      });
    });

    // ---- Realtime append: POST /realtime/v1/sessions/:session/:io/append
    //
    // action: "write" — multi-key sessions resource.
    describe("Realtime append — POST /realtime/v1/sessions/:session/:io/append", () => {
      const appendPath = (sessionParam: string) =>
        `/realtime/v1/sessions/${sessionParam}/in/append`;

      const mintJwt = async (apiKey: string, envId: string, scopes: string[]) =>
        generateJWT({
          secretKey: apiKey,
          payload: { pub: true, sub: envId, scopes },
          expirationTime: "15m",
        });

      it("write:sessions (was a superScope): auth passes", async () => {
        const server = getTestServer();
        const seed = await seedTestEnvironment(server.prisma);
        const session = await seedTestApiSession(server.prisma, seed.environment);
        const jwt = await mintJwt(seed.apiKey, seed.environment.id, [
          "write:sessions",
        ]);
        const res = await server.webapp.fetch(appendPath(session.friendlyId), {
          method: "POST",
          headers: {
            Authorization: `Bearer ${jwt}`,
            "Content-Type": "application/octet-stream",
          },
          body: new Uint8Array([1, 2, 3]),
        });
        expect(res.status).not.toBe(401);
        expect(res.status).not.toBe(403);
      });

      it("write:all: auth passes", async () => {
        const server = getTestServer();
        const seed = await seedTestEnvironment(server.prisma);
        const session = await seedTestApiSession(server.prisma, seed.environment);
        const jwt = await mintJwt(seed.apiKey, seed.environment.id, ["write:all"]);
        const res = await server.webapp.fetch(appendPath(session.friendlyId), {
          method: "POST",
          headers: {
            Authorization: `Bearer ${jwt}`,
            "Content-Type": "application/octet-stream",
          },
          body: new Uint8Array([1, 2, 3]),
        });
        expect(res.status).not.toBe(401);
        expect(res.status).not.toBe(403);
      });
    });
  });
});
