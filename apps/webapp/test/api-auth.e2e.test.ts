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
import { createHash } from "node:crypto";
import { generateAdditionalApiKey } from "~/utils/apiKeys";
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

describe("Packet download authorization", () => {
  // The auth harness has no object store. Reaching its configuration error proves that
  // resource lookup and authorization passed and the handler attempted to presign.
  const objectStoreError = {
    error: "Failed to generate presigned URL: Object store is not configured for protocol: default",
  };

  async function seedStoredRuns() {
    const seed = await seedTestEnvironment(server.prisma);
    const first = await seedTestRun(server.prisma, {
      environmentId: seed.environment.id,
      projectId: seed.project.id,
    });
    const second = await seedTestRun(server.prisma, {
      environmentId: seed.environment.id,
      projectId: seed.project.id,
    });

    await Promise.all([
      server.prisma.taskRun.update({
        where: { id: first.run.id },
        data: {
          payload: `${first.runFriendlyId}/payload.json`,
          payloadType: "application/store",
          output: `${first.runFriendlyId}-1/output.json`,
          outputType: "application/store",
        },
      }),
      server.prisma.taskRun.update({
        where: { id: second.run.id },
        data: {
          payload: `${second.runFriendlyId}/payload.json`,
          payloadType: "application/store",
        },
      }),
    ]);

    return { ...seed, first, second };
  }

  it("authorizes run packet downloads against the token's run scope", async () => {
    const { environment, first, second } = await seedStoredRuns();
    const firstJwt = await generateTestJWT(environment, {
      scopes: [`read:runs:${first.runFriendlyId}`],
    });
    const secondJwt = await generateTestJWT(environment, {
      scopes: [`read:runs:${second.runFriendlyId}`],
    });
    const asFirst = { headers: { Authorization: `Bearer ${firstJwt}` } };
    const asSecond = { headers: { Authorization: `Bearer ${secondJwt}` } };

    const ownPayload = await server.webapp.fetch(
      `/api/v1/runs/${first.runFriendlyId}/packets/payload`,
      asFirst
    );
    const ownOutput = await server.webapp.fetch(
      `/api/v1/runs/${first.runFriendlyId}/packets/output`,
      asFirst
    );
    const otherRun = await server.webapp.fetch(
      `/api/v1/runs/${second.runFriendlyId}/packets/payload`,
      asFirst
    );
    const inlineOutput = await server.webapp.fetch(
      `/api/v1/runs/${second.runFriendlyId}/packets/output`,
      asSecond
    );

    expect(ownPayload.status).toBe(500);
    expect(await ownPayload.json()).toEqual(objectStoreError);
    expect(ownOutput.status).toBe(500);
    expect(await ownOutput.json()).toEqual(objectStoreError);
    expect(otherRun.status).toBe(403);
    expect(inlineOutput.status).toBe(404);
  });

  describe.each([
    "public JWT",
    "restricted API key",
    "root API key",
    "unrestricted API key",
  ] as const)("%s stored pointers", (credential) => {
    it.each([
      "trigger",
      "v1 batch",
      "v2 batch",
      "v3 items",
      // This legacy route does not accept public JWTs.
      ...(credential === "public JWT" ? [] : (["task-scoped v1 batch"] as const)),
    ] as const)("enforces stored-pointer permission on %s", async (route) => {
      const { environment, project } = await seedTestEnvironment(server.prisma);
      const { batchFriendlyId: seededBatchFriendlyId, run } = await seedTestRun(server.prisma, {
        environmentId: environment.id,
        projectId: project.id,
        withBatch: route !== "v3 items",
      });
      let batchFriendlyId = seededBatchFriendlyId;
      if (route === "v3 items") {
        // Phase 1 initializes both the database record and Redis queue metadata.
        const response = await server.webapp.fetch("/api/v3/batches", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${environment.apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ runCount: 1, taskIdentifiers: ["test-task"] }),
        });
        expect(response.status).toBe(202);
        batchFriendlyId = (await response.json()).id;
      } else {
        await server.prisma.batchTaskRun.update({
          where: { id: run.batchId! },
          data: { status: "PENDING", runCount: 1 },
        });
      }
      // Keep JSON-route controls independent of worker/deployment setup.
      // The payload gate must run even when a matching run is cached.
      const idempotencyKey = "stored-payload-authorization";
      await server.prisma.taskRun.update({
        where: { id: run.id },
        data: {
          idempotencyKey,
          idempotencyKeyExpiresAt: new Date(Date.now() + 3_600_000),
        },
      });

      let token: string;
      if (credential === "public JWT") {
        // Include a batch-wide grant to ensure it cannot bypass the payload gate.
        token = await generateTestJWT(environment, {
          scopes: ["write:tasks:test-task", `write:batch:${batchFriendlyId}`],
        });
      } else if (credential === "root API key") {
        token = environment.apiKey;
      } else {
        const user = await seedTestUser(server.prisma);
        token = generateAdditionalApiKey("DEVELOPMENT").apiKey;
        await server.prisma.apiKey.create({
          data: {
            name: "Task-scoped ingestion key",
            keyHash: createHash("sha256").update(token).digest("hex"),
            lastFour: token.slice(-4),
            runtimeEnvironmentId: environment.id,
            createdByUserId: user.id,
            presetId: credential === "restricted API key" ? "TRIGGER_ONLY" : null,
            scopes:
              credential === "restricted API key"
                ? ["trigger:tasks:test-task", "batchTrigger:tasks:test-task"]
                : ["admin"],
          },
        });
      }

      const item = {
        task: "test-task",
        index: 0,
        payload: "run_other/payload.json",
        options: { payloadType: "application/store", idempotencyKey },
      };
      const path =
        route === "trigger"
          ? "/api/v1/tasks/test-task/trigger"
          : route === "v3 items"
            ? `/api/v3/batches/${batchFriendlyId}/items`
            : route === "task-scoped v1 batch"
              ? "/api/v1/tasks/test-task/batch"
              : `/api/${route === "v1 batch" ? "v1" : "v2"}/tasks/batch`;
      const res = await server.webapp.fetch(path, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "idempotency-key": idempotencyKey,
          "Content-Type": route === "v3 items" ? "application/x-ndjson" : "application/json",
        },
        body:
          route === "v3 items"
            ? `${JSON.stringify(item)}\n`
            : JSON.stringify(route === "trigger" ? item : { items: [item] }),
      });

      if (credential === "public JWT" || credential === "restricted API key") {
        expect(res.status).toBe(403);
        expect(await res.json()).toEqual({
          error:
            route === "v3 items"
              ? "Unauthorized"
              : "Stored payloads require an unrestricted private API key",
        });
        expect(
          await server.prisma.taskRun.count({ where: { runtimeEnvironmentId: environment.id } })
        ).toBe(1);
        expect(
          await server.prisma.batchTaskRun.count({
            where: { runtimeEnvironmentId: environment.id },
          })
        ).toBe(1);
        expect(
          await server.prisma.batchTaskRun.findFirst({ where: { friendlyId: batchFriendlyId } })
        ).toMatchObject({ status: "PENDING", sealed: false });
        if (route === "task-scoped v1 batch" && credential === "restricted API key") {
          const inlineResponse = await server.webapp.fetch(path, {
            method: "POST",
            headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
            body: JSON.stringify({
              items: [{ payload: { message: "inline" }, options: { idempotencyKey } }],
            }),
          });
          expect(inlineResponse.status).toBe(200);
          expect(await inlineResponse.json()).toMatchObject({
            batchId: expect.stringMatching(/^batch_/),
            runs: [run.friendlyId],
          });
        }
      } else {
        expect(res.status).toBe(route === "v1 batch" || route === "v2 batch" ? 202 : 200);
        if (route === "trigger") {
          expect(await res.json()).toMatchObject({ id: run.friendlyId, isCached: true });
        } else if (route === "v3 items") {
          expect(await res.json()).toMatchObject({ itemsAccepted: 1, sealed: true });
        } else if (route === "task-scoped v1 batch") {
          expect(await res.json()).toMatchObject({
            batchId: expect.stringMatching(/^batch_/),
            runs: [run.friendlyId],
          });
        } else {
          expect(await res.json()).toMatchObject({ id: expect.stringMatching(/^batch_/) });
        }
      }
    });
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
// whether a plugin is installed in node_modules. /admin/feature-flags
// uses rbac.authenticateSession internally; an unauthenticated request
// must flow through LazyController → RoleBaseAccessFallback →
// redirect("/login").
describe("RBAC plugin — fallback wiring", () => {
  it("unauthenticated dashboard route redirects to /login via the fallback", async () => {
    const res = await server.webapp.fetch("/admin/feature-flags", { redirect: "manual" });
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
  it('custom action: type-level write:tasks scope satisfies action="trigger" (auth passes)', async () => {
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

describe("admin waitpoint rollout controls", () => {
  it("saves the normal org/global flag without writing derived global state", async () => {
    const user = await seedTestUser(server.prisma, { admin: true });
    const pat = await seedTestPAT(server.prisma, user.id);
    const organization = await server.prisma.organization.create({
      data: { title: "Waitpoint rollout", slug: `waitpoint-rollout-${user.id}` },
    });
    const post = async (path: string, body: unknown) => {
      const response = await server.webapp.fetch(path, {
        method: "POST",
        headers: { Authorization: `Bearer ${pat.token}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      expect(response.status, await response.text()).toBe(200);
    };
    const globalPath = "/admin/api/v1/feature-flags";
    try {
      await post(`/admin/api/v1/orgs/${organization.id}/feature-flags`, {
        waitpointStoreEnabled: true,
      });
      await post(globalPath, { waitpointStoreEnabled: false });
      expect(
        (await server.prisma.organization.findFirstOrThrow({ where: { id: organization.id } }))
          .featureFlags
      ).toMatchObject({ waitpointStoreEnabled: true });
      expect(
        await server.prisma.featureFlag.findFirst({ where: { key: "waitpointRolloutState" } })
      ).toBeNull();
    } finally {
      await post(globalPath, { waitpointStoreEnabled: false });
    }
  });
});
