// A rotated root key keeps authenticating during its grace window so callers
// can switch over without downtime. These tests lock in that the old key can't
// use that window to recover its replacement: it can't read whoami, ship a
// deployment, or touch the environment's variables, while the current key can.

import { describe, expect, it } from "vitest";
import { getTestServer } from "./helpers/sharedTestServer";
import { seedTestEnvironment } from "./helpers/seedTestEnvironment";

async function seedRotatedEnvironment() {
  const server = getTestServer();
  const seeded = await seedTestEnvironment(server.prisma);
  const currentKey = `tr_dev_rotated_${Math.random().toString(36).slice(2)}`;

  // Rotate exactly as regenerate-api-key does: new value on the env, old value
  // parked in RevokedApiKey with a future grace expiry.
  await server.prisma.$transaction([
    server.prisma.revokedApiKey.create({
      data: {
        apiKey: seeded.apiKey,
        runtimeEnvironmentId: seeded.environment.id,
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      },
    }),
    server.prisma.runtimeEnvironment.update({
      where: { id: seeded.environment.id },
      data: { apiKey: currentKey },
    }),
  ]);

  return { ...seeded, rotatedKey: seeded.apiKey, currentKey };
}

function request(path: string, authorization: string, init: RequestInit = {}) {
  return getTestServer().webapp.fetch(path, {
    ...init,
    headers: {
      Authorization: authorization,
      "Content-Type": "application/json",
      ...init.headers,
    },
  });
}

describe("rotated root keys during the grace window", () => {
  // Catches: whoami handing a rotated key the environment's replacement root key.
  it("whoami rejects the rotated key and never returns key material", async () => {
    const { rotatedKey, currentKey } = await seedRotatedEnvironment();

    const rotated = await request("/api/v1/whoami", `Bearer ${rotatedKey}`);
    expect(rotated.status).toBe(401);

    const current = await request("/api/v1/whoami", `Bearer ${currentKey}`);
    expect(current.status).toBe(200);
    const body = JSON.stringify(await current.json());
    expect(body).not.toContain(currentKey);
    expect(body).not.toContain("apiKey");
  });

  // Catches: a rotated key reading env vars, which can hold secrets updated after the rotation.
  it("rejects env var reads with the rotated key", async () => {
    const { project, rotatedKey, currentKey } = await seedRotatedEnvironment();
    const path = `/api/v1/projects/${project.externalRef}/envvars/dev`;

    expect((await request(path, `Bearer ${rotatedKey}`)).status).toBe(401);
    expect((await request(path, `Bearer ${currentKey}`)).status).toBe(200);
  });

  // Catches: a rotated key setting a variable such as NODE_OPTIONS that runs code with the new key.
  it("rejects env var writes with the rotated key", async () => {
    const { project, rotatedKey, currentKey } = await seedRotatedEnvironment();
    const path = `/api/v1/projects/${project.externalRef}/envvars/dev`;
    const init = { method: "POST", body: JSON.stringify({ name: "E2E_VAR", value: "x" }) };

    expect((await request(path, `Bearer ${rotatedKey}`, init)).status).toBe(401);
    expect((await request(path, `Bearer ${currentKey}`, init)).status).toBe(200);
  });

  // Catches: a rotated key driving a deployment whose runs receive the new key.
  it("rejects deployment writes with the rotated key", async () => {
    const { rotatedKey, currentKey } = await seedRotatedEnvironment();
    const path = "/api/v1/deployments/deployment_missing/progress";
    const init = { method: "POST", body: JSON.stringify({}) };

    expect((await request(path, `Bearer ${rotatedKey}`, init)).status).toBe(401);
    // Past auth, the current key reaches the handler, which finds no deployment.
    expect((await request(path, `Bearer ${currentKey}`, init)).status).toBe(404);
  });

  // Catches: extra whitespace after "Bearer" authenticating the rotated key while the grace-window lookup misses it.
  it("rejects the rotated key with extra whitespace in the header", async () => {
    const { project, rotatedKey } = await seedRotatedEnvironment();

    const res = await request(
      `/api/v1/projects/${project.externalRef}/envvars/dev`,
      `Bearer  ${rotatedKey}`
    );
    expect(res.status).toBe(401);
  });

  // Catches: the restriction spilling over and breaking the zero-downtime switchover for reads.
  it("still lets the rotated key read deployments", async () => {
    const { rotatedKey } = await seedRotatedEnvironment();

    // Past auth, the handler finds no deployment for the fresh environment.
    const res = await request("/api/v1/deployments/latest", `Bearer ${rotatedKey}`);
    expect(res.status).toBe(404);
  });
});
