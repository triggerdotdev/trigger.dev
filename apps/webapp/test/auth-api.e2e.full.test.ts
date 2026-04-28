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

    it("valid PAT, project exists in user's org: 2xx", async () => {
      const server = getTestServer();
      const { project, pat } = await seedTestUserProject(server.prisma);
      const res = await server.webapp.fetch(pathFor(project.externalRef), {
        headers: { Authorization: `Bearer ${pat.token}` },
      });
      // Auth + scoping pass — handler returns the run list (empty by default).
      expect(res.status).toBe(200);
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
      expect(res.status).toBe(200);
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

    it("valid PAT, admin user accessing their OWN project: 2xx", async () => {
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
      expect(res.status).toBe(200);
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
  // [{type:"tasks", id}, ...]; v3 batches use a collection-level
  // resource { type: "tasks" } (no id — items are validated per-row
  // when streamed).
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

    it("JWT with batchTrigger:tasks:taskA + body has [taskA, taskB]: auth passes (any-match)", async () => {
      // Multi-key resource semantics: when the route's resource is an
      // array, ANY scope matching ANY array element grants access.
      // Locks in the legacy contract from TRI-8719.
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

    it("private API key: 200", async () => {
      const server = getTestServer();
      const seed = await seedTestEnvironment(server.prisma);
      const res = await get("", { Authorization: `Bearer ${seed.apiKey}` });
      expect(res.status).toBe(200);
    });

    it("JWT with read:runs (collection-level): 200", async () => {
      const server = getTestServer();
      const seed = await seedTestEnvironment(server.prisma);
      const jwt = await generateJWT({
        secretKey: seed.apiKey,
        payload: { pub: true, sub: seed.environment.id, scopes: ["read:runs"] },
        expirationTime: "15m",
      });
      const res = await get("", { Authorization: `Bearer ${jwt}` });
      expect(res.status).toBe(200);
    });

    it("JWT with read:all super-scope: 200", async () => {
      const server = getTestServer();
      const seed = await seedTestEnvironment(server.prisma);
      const jwt = await generateJWT({
        secretKey: seed.apiKey,
        payload: { pub: true, sub: seed.environment.id, scopes: ["read:all"] },
        expirationTime: "15m",
      });
      const res = await get("", { Authorization: `Bearer ${jwt}` });
      expect(res.status).toBe(200);
    });

    it("JWT with admin: 200", async () => {
      const server = getTestServer();
      const seed = await seedTestEnvironment(server.prisma);
      const jwt = await generateJWT({
        secretKey: seed.apiKey,
        payload: { pub: true, sub: seed.environment.id, scopes: ["admin"] },
        expirationTime: "15m",
      });
      const res = await get("", { Authorization: `Bearer ${jwt}` });
      expect(res.status).toBe(200);
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
      expect(res.status).toBe(200);
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
});
