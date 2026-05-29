/**
 * E2E auth baseline tests.
 *
 * These tests capture current auth behavior before the apiBuilder migration to RBAC.
 * Run them before and after the migration to verify behavior is identical.
 *
 * Requires a pre-built webapp: pnpm run build --filter webapp
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { TestServer } from "@internal/testcontainers/webapp";
import { startTestServer } from "@internal/testcontainers/webapp";
import { generateJWT } from "@trigger.dev/core/v3/jwt";
import { seedTestEnvironment } from "./helpers/seedTestEnvironment";
import { seedTestPAT, seedTestUser } from "./helpers/seedTestPAT";
import { seedTestRun } from "./helpers/seedTestRun";
import { seedTestWaitpoint } from "./helpers/seedTestWaitpoint";

vi.setConfig({ testTimeout: 180_000 });

// Shared across all tests in this file — one postgres container + one webapp instance.
let server: TestServer;

beforeAll(async () => {
  server = await startTestServer();
}, 180_000);

afterAll(async () => {
  await server?.stop();
}, 120_000);

async function generateTestJWT(
  environment: { id: string; apiKey: string },
  options: { scopes?: string[] } = {}
): Promise<string> {
  const scopes = options.scopes ?? ["read:runs"];
  return generateJWT({
    secretKey: environment.apiKey,
    payload: { pub: true, sub: environment.id, scopes },
    expirationTime: "15m",
  });
}

describe("API bearer auth — baseline behavior", () => {
  it("valid API key: auth passes (404 not 401)", async () => {
    const { apiKey } = await seedTestEnvironment(server.prisma);
    const res = await server.webapp.fetch("/api/v1/runs/run_doesnotexist/result", {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    // Auth passed — resource just doesn't exist
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(403);
  });

  it("missing Authorization header: 401", async () => {
    const res = await server.webapp.fetch("/api/v1/runs/run_doesnotexist/result");
    expect(res.status).toBe(401);
  });

  it("invalid API key: 401", async () => {
    const res = await server.webapp.fetch("/api/v1/runs/run_doesnotexist/result", {
      headers: { Authorization: "Bearer tr_dev_completely_invalid_key_xyz_not_real" },
    });
    expect(res.status).toBe(401);
  });

  it("401 response has error field", async () => {
    const res = await server.webapp.fetch("/api/v1/runs/run_doesnotexist/result");
    const body = await res.json();
    expect(body).toHaveProperty("error");
  });
});

describe("JWT bearer auth — baseline behavior", () => {
  it("valid JWT on JWT-enabled route: auth passes", async () => {
    const { environment } = await seedTestEnvironment(server.prisma);
    const jwt = await generateTestJWT(environment, { scopes: ["read:runs"] });

    // /api/v1/runs has allowJWT: true with superScopes: ["read:runs", ...]
    const res = await server.webapp.fetch("/api/v1/runs", {
      headers: { Authorization: `Bearer ${jwt}` },
    });

    // Auth passed — 200 (empty list) or 400 (bad search params), not 401
    expect(res.status).not.toBe(401);
  });

  it("valid JWT on non-JWT route: 401", async () => {
    const { environment } = await seedTestEnvironment(server.prisma);
    const jwt = await generateTestJWT(environment, { scopes: ["read:runs"] });

    // /api/v1/runs/$runParam/result does NOT have allowJWT: true
    const res = await server.webapp.fetch("/api/v1/runs/run_doesnotexist/result", {
      headers: { Authorization: `Bearer ${jwt}` },
    });

    expect(res.status).toBe(401);
  });

  it("JWT with empty scopes on JWT-enabled route: 403", async () => {
    const { environment } = await seedTestEnvironment(server.prisma);
    const jwt = await generateTestJWT(environment, { scopes: [] });

    const res = await server.webapp.fetch("/api/v1/runs", {
      headers: { Authorization: `Bearer ${jwt}` },
    });

    // Empty scopes → no read:runs permission → 403
    expect(res.status).toBe(403);
  });

  it("JWT signed with wrong key: 401", async () => {
    const { environment } = await seedTestEnvironment(server.prisma);
    const jwt = await generateJWT({
      secretKey: "wrong-signing-key-that-does-not-match-environment-key",
      payload: { pub: true, sub: environment.id, scopes: ["read:runs"] },
    });

    const res = await server.webapp.fetch("/api/v1/runs", {
      headers: { Authorization: `Bearer ${jwt}` },
    });

    expect(res.status).toBe(401);
  });
});

// Exercises the RBAC plugin loader end-to-end. The test server boots
// with RBAC_FORCE_FALLBACK=1 (see internal-packages/testcontainers/src/webapp.ts),
// which makes rbac.server.ts use the default fallback regardless of
// whether a plugin is installed in node_modules. /admin/concurrency
// uses rbac.authenticateSession internally; an unauthenticated request
// must flow through LazyController → RoleBaseAccessFallback →
// redirect("/login").
describe("RBAC plugin — fallback wiring", () => {
  it("unauthenticated dashboard route redirects to /login via the fallback", async () => {
    const res = await server.webapp.fetch("/admin/concurrency", { redirect: "manual" });
    expect(res.status).toBe(302);
    const location = res.headers.get("location") ?? "";
    expect(new URL(location, "http://placeholder").pathname).toBe("/login");
  });
});

// Covers createActionApiRoute's bearer auth path. The target route is
// POST /api/v1/idempotencyKeys/:key/reset — allowJWT: true, superScopes: ["write:runs", "admin"].
// Tests assert HTTP-observable behavior so they remain valid after TRI-8719 swaps
// authenticateApiRequestWithFailure for rbac.authenticateBearer.
describe("API bearer auth — action requests", () => {
  const targetPath = "/api/v1/idempotencyKeys/does-not-exist/reset";

  it("valid API key: auth passes (body validation fails, not 401/403)", async () => {
    const { apiKey } = await seedTestEnvironment(server.prisma);
    const res = await server.webapp.fetch(targetPath, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({}), // missing taskIdentifier → zod validation error
    });
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(403);
  });

  it("missing Authorization header: 401", async () => {
    const res = await server.webapp.fetch(targetPath, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ taskIdentifier: "noop" }),
    });
    expect(res.status).toBe(401);
  });

  it("invalid API key: 401", async () => {
    const res = await server.webapp.fetch(targetPath, {
      method: "POST",
      headers: {
        Authorization: "Bearer tr_dev_completely_invalid_key_xyz_not_real",
        "content-type": "application/json",
      },
      body: JSON.stringify({ taskIdentifier: "noop" }),
    });
    expect(res.status).toBe(401);
  });

});

describe("JWT bearer auth — action requests", () => {
  const targetPath = "/api/v1/idempotencyKeys/does-not-exist/reset";

  it("JWT with matching scope: auth passes", async () => {
    const { environment } = await seedTestEnvironment(server.prisma);
    const jwt = await generateTestJWT(environment, { scopes: ["write:runs"] });
    const res = await server.webapp.fetch(targetPath, {
      method: "POST",
      headers: { Authorization: `Bearer ${jwt}`, "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(403);
  });

  it("JWT with wrong scope (read-only) on write route: 403", async () => {
    const { environment } = await seedTestEnvironment(server.prisma);
    const jwt = await generateTestJWT(environment, { scopes: ["read:runs"] });
    const res = await server.webapp.fetch(targetPath, {
      method: "POST",
      headers: { Authorization: `Bearer ${jwt}`, "content-type": "application/json" },
      body: JSON.stringify({ taskIdentifier: "noop" }),
    });
    expect(res.status).toBe(403);
  });
});

// Covers createLoaderPATApiRoute via GET /api/v1/projects/:projectRef/runs.
// authenticateApiRequestWithPersonalAccessToken rejects anything that isn't tr_pat_-prefixed
// or doesn't match a non-revoked PersonalAccessToken row.
describe("Personal access token auth", () => {
  const pathFor = (ref: string) => `/api/v1/projects/${ref}/runs`;

  it("missing Authorization header: 401", async () => {
    const res = await server.webapp.fetch(pathFor("nonexistent"));
    expect(res.status).toBe(401);
  });

  it("API key (tr_dev_*) on PAT-only route: 401", async () => {
    const { apiKey } = await seedTestEnvironment(server.prisma);
    const res = await server.webapp.fetch(pathFor("nonexistent"), {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    expect(res.status).toBe(401);
  });

  it("malformed PAT (wrong prefix): 401", async () => {
    const res = await server.webapp.fetch(pathFor("nonexistent"), {
      headers: { Authorization: "Bearer not_a_pat_at_all_random_string" },
    });
    expect(res.status).toBe(401);
  });

  it("well-formed but unknown PAT: 401", async () => {
    const res = await server.webapp.fetch(pathFor("nonexistent"), {
      headers: {
        Authorization: "Bearer tr_pat_0000000000000000000000000000000000000000",
      },
    });
    expect(res.status).toBe(401);
  });

  it("revoked PAT: 401", async () => {
    const user = await seedTestUser(server.prisma);
    const { token } = await seedTestPAT(server.prisma, user.id, { revoked: true });
    const res = await server.webapp.fetch(pathFor("nonexistent"), {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(401);
  });

  it("valid PAT on nonexistent project: 404 (auth passes)", async () => {
    const user = await seedTestUser(server.prisma);
    const { token } = await seedTestPAT(server.prisma, user.id);
    const res = await server.webapp.fetch(pathFor("nonexistent"), {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(404);
  });
});

// Verifies resource-scoped JWT behaviour end-to-end against a real seeded resource.
// Target: POST /api/v1/waitpoints/tokens/:waitpointFriendlyId/complete — allowJWT: true,
// authorization: { action: "write", resource: (params) => ({ waitpoints: params.waitpointFriendlyId }),
// superScopes: ["write:waitpoints", "admin"] }.
//
// The Waitpoint is seeded with status COMPLETED so the handler short-circuits with
// { success: true } once auth passes — no run-engine worker needed. "Auth passes" is
// observable as a 200 response; "auth fails" is observable as a 403.
describe("JWT bearer auth — resource-scoped scopes", () => {
  const pathFor = (friendlyId: string) => `/api/v1/waitpoints/tokens/${friendlyId}/complete`;

  async function seedEnvAndWaitpoint() {
    const seed = await seedTestEnvironment(server.prisma);
    const waitpoint = await seedTestWaitpoint(server.prisma, {
      environmentId: seed.environment.id,
      projectId: seed.project.id,
    });
    return { ...seed, waitpoint };
  }

  async function completeRequest(friendlyId: string, jwt: string) {
    return server.webapp.fetch(pathFor(friendlyId), {
      method: "POST",
      headers: { Authorization: `Bearer ${jwt}`, "content-type": "application/json" },
      body: JSON.stringify({}),
    });
  }

  it("scope matches exact resource id: 200", async () => {
    const { environment, waitpoint } = await seedEnvAndWaitpoint();
    const jwt = await generateTestJWT(environment, {
      scopes: [`write:waitpoints:${waitpoint.friendlyId}`],
    });
    const res = await completeRequest(waitpoint.friendlyId, jwt);
    expect(res.status).toBe(200);
  });

  it("scope targets a different resource id: 403", async () => {
    const { environment, waitpoint } = await seedEnvAndWaitpoint();
    const jwt = await generateTestJWT(environment, {
      scopes: ["write:waitpoints:waitpoint_someoneelse000000000000000"],
    });
    const res = await completeRequest(waitpoint.friendlyId, jwt);
    expect(res.status).toBe(403);
  });

  it("type-level scope (no id) grants all resources of that type: 200", async () => {
    const { environment, waitpoint } = await seedEnvAndWaitpoint();
    const jwt = await generateTestJWT(environment, { scopes: ["write:waitpoints"] });
    const res = await completeRequest(waitpoint.friendlyId, jwt);
    expect(res.status).toBe(200);
  });

  it("scope action mismatch (read-only on write route) with matching resource id: 403", async () => {
    const { environment, waitpoint } = await seedEnvAndWaitpoint();
    const jwt = await generateTestJWT(environment, {
      scopes: [`read:waitpoints:${waitpoint.friendlyId}`],
    });
    const res = await completeRequest(waitpoint.friendlyId, jwt);
    expect(res.status).toBe(403);
  });

  it("scope targets a different resource type: 403", async () => {
    const { environment, waitpoint } = await seedEnvAndWaitpoint();
    const jwt = await generateTestJWT(environment, {
      scopes: ["write:runs:run_abc000000000000000000000"],
    });
    const res = await completeRequest(waitpoint.friendlyId, jwt);
    expect(res.status).toBe(403);
  });

  it("admin super-scope grants access (legacy behaviour): 200", async () => {
    const { environment, waitpoint } = await seedEnvAndWaitpoint();
    const jwt = await generateTestJWT(environment, { scopes: ["admin"] });
    const res = await completeRequest(waitpoint.friendlyId, jwt);
    expect(res.status).toBe(200);
  });

  it("unrelated type scope with no super-scope match: 403", async () => {
    const { environment, waitpoint } = await seedEnvAndWaitpoint();
    const jwt = await generateTestJWT(environment, { scopes: ["read:runs"] });
    const res = await completeRequest(waitpoint.friendlyId, jwt);
    expect(res.status).toBe(403);
  });
});

// Pre-migration coverage for the three behavioural constraints captured in TRI-8719.
// Each test locks in an observable current behaviour that the migration must preserve:
// - custom actions (trigger/batchTrigger/update) satisfied by write:* scopes
// - multi-key resource callbacks (runs/tags/batch/tasks) — any key match grants access
// - empty resource callbacks relying on superScopes
describe("JWT bearer auth — behaviours to preserve through TRI-8719", () => {
  it("custom action: type-level write:tasks scope satisfies action=\"trigger\" (auth passes)", async () => {
    const { environment } = await seedTestEnvironment(server.prisma);
    // Current SDK + MCP JWTs for task-trigger use type-level scope, e.g. write:tasks.
    // Legacy checkAuthorization passes via exact superScope match ["write:tasks", "admin"].
    // After TRI-8719, the ACTION_ALIASES map must keep this working: trigger action is
    // satisfied by a scope whose action is write.
    const jwt = await generateTestJWT(environment, { scopes: ["write:tasks"] });
    const res = await server.webapp.fetch("/api/v1/tasks/nonexistent-task/trigger", {
      method: "POST",
      headers: { Authorization: `Bearer ${jwt}`, "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(403);
  });

  it("multi-key resource: read:tags:<tag> scope grants access to a run carrying that tag (auth passes)", async () => {
    const { environment, project } = await seedTestEnvironment(server.prisma);
    const { runFriendlyId } = await seedTestRun(server.prisma, {
      environmentId: environment.id,
      projectId: project.id,
      runTags: ["my-resource-scoped-tag"],
    });
    const jwt = await generateTestJWT(environment, {
      scopes: ["read:tags:my-resource-scoped-tag"],
    });
    const res = await server.webapp.fetch(`/api/v1/runs/${runFriendlyId}/trace`, {
      headers: { Authorization: `Bearer ${jwt}` },
    });
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(403);
  });

  it("multi-key resource: read:batch:<friendlyId> scope grants access to a run in that batch (auth passes)", async () => {
    const { environment, project } = await seedTestEnvironment(server.prisma);
    const { runFriendlyId, batchFriendlyId } = await seedTestRun(server.prisma, {
      environmentId: environment.id,
      projectId: project.id,
      withBatch: true,
    });
    const jwt = await generateTestJWT(environment, {
      scopes: [`read:batch:${batchFriendlyId}`],
    });
    const res = await server.webapp.fetch(`/api/v1/runs/${runFriendlyId}/trace`, {
      headers: { Authorization: `Bearer ${jwt}` },
    });
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(403);
  });

  // Empty-resource routes (api.v1.batches.ts, api.v1.idempotencyKeys.$key.reset.ts)
  // currently DENY all JWTs because legacy checkAuthorization's empty-resource check
  // fires before the superScope check. TRI-8719's plan to add explicit { type: "runs" }
  // changes this to "JWTs with read:runs or write:runs now work on these routes" — an
  // intentional improvement, not a preserved behaviour. See TRI-8719 description for
  // the note; there's nothing to lock in with a test here.
});

// Edge cases where auth-path DB state should cause 401 even with a valid-looking token.
describe("API bearer auth — environment/project edge cases", () => {
  it("valid API key whose project is soft-deleted: 401", async () => {
    const { apiKey, project } = await seedTestEnvironment(server.prisma);
    await server.prisma.project.update({
      where: { id: project.id },
      data: { deletedAt: new Date() },
    });
    const res = await server.webapp.fetch("/api/v1/runs/run_doesnotexist/result", {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    expect(res.status).toBe(401);
  });
});
