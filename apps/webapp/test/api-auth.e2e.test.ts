/**
 * E2E auth baseline tests.
 *
 * These tests capture current auth behavior before the apiBuilder migration to RBAC.
 * Run them before and after the migration to verify behavior is identical.
 *
 * Requires a pre-built webapp: pnpm run build --filter webapp
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { TestServer } from "@internal/testcontainers/webapp";
import { startTestServer } from "@internal/testcontainers/webapp";
import { generateJWT } from "@trigger.dev/core/v3/jwt";
import { seedTestEnvironment } from "./helpers/seedTestEnvironment";

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
