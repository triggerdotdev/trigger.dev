import { generateJWT } from "@trigger.dev/core/v3/jwt";
import type { TestServer } from "@internal/testcontainers/webapp";
import { startTestServer } from "@internal/testcontainers/webapp";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { seedTestApiSession } from "./helpers/seedTestApiSession";
import { seedTestEnvironment } from "./helpers/seedTestEnvironment";

vi.setConfig({ testTimeout: 180_000, hookTimeout: 240_000 });

let server: TestServer;

beforeAll(async () => {
  server = await startTestServer({
    extraEnv: {
      OBJECT_STORE_BASE_URL: "http://object-store.example.test",
      OBJECT_STORE_ACCESS_KEY_ID: "test-access-key",
      OBJECT_STORE_SECRET_ACCESS_KEY: "test-secret-key",
    },
  });
}, 240_000);

afterAll(async () => {
  await server?.stop();
}, 120_000);

async function setupSession() {
  const seed = await seedTestEnvironment(server.prisma);
  const session = await seedTestApiSession(server.prisma, seed.environment);
  const publicToken = await generateJWT({
    secretKey: seed.apiKey,
    payload: {
      pub: true,
      sub: seed.environment.id,
      scopes: [`read:sessions:${session.friendlyId}`, `write:sessions:${session.friendlyId}`],
    },
    expirationTime: "15m",
  });

  return { ...seed, session, publicToken };
}

function requestSnapshotUrl(sessionId: string, method: "GET" | "PUT", token: string) {
  return server.webapp.fetch(`/api/v1/sessions/${sessionId}/snapshot-url`, {
    method,
    headers: { Authorization: `Bearer ${token}` },
  });
}

describe("session snapshot URL auth", () => {
  it("denies a presigned PUT to a public session token", async () => {
    const { session, publicToken } = await setupSession();

    const response = await requestSnapshotUrl(session.friendlyId, "PUT", publicToken);

    expect(response.status).toBe(401);
  });

  it("returns a presigned PUT to the private runtime API key", async () => {
    const { apiKey, session } = await setupSession();

    const response = await requestSnapshotUrl(session.friendlyId, "PUT", apiKey);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ presignedUrl: expect.any(String) });
  });
});
