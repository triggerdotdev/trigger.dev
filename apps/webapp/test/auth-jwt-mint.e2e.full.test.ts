// POST /api/v1/auth/jwt hardening — the route spreads caller-supplied claims
// into a public JWT. These tests lock in that:
//   1. caller `expirationTime` is capped (an uncapped "100y" mints a token no
//      key rotation can revoke, since public JWTs outlive key rotation);
//   2. a revoked (grace-window) key can no longer mint — those tokens are
//      signed with the replacement key, so they kept validating after
//      rotation, defeating revocation;
//   3. a valid root key still mints, with the requested scopes echoed back.
//
// Scope *inflation* for a restricted additional key is covered by the
// scope-grammar unit tests (internal-packages/rbac ability.test.ts) plus the
// route's `scopesWithinAbility` clamp; the shared e2e server runs with the
// additional-key lookup flag off, so an additional-key mint would 401 here for
// an unrelated reason.

import { describe, expect, it } from "vitest";
import { getTestServer } from "./helpers/sharedTestServer";
import { seedTestEnvironment } from "./helpers/seedTestEnvironment";

const ROUTE = "/api/v1/auth/jwt";

function mint(apiKey: string, body: unknown) {
  const server = getTestServer();
  return server.webapp.fetch(ROUTE, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

function decodePayload(token: string): Record<string, unknown> {
  const part = token.split(".")[1]!;
  const base64 = part.replace(/-/g, "+").replace(/_/g, "/");
  return JSON.parse(Buffer.from(base64, "base64").toString("utf8"));
}

describe("POST /api/v1/auth/jwt", () => {
  it("mints a token for a valid root key, echoing the requested scopes", async () => {
    const server = getTestServer();
    const { apiKey, environment } = await seedTestEnvironment(server.prisma);

    const res = await mint(apiKey, {
      claims: { scopes: ["read:runs"] },
      expirationTime: "1h",
    });
    expect(res.status).toBe(200);

    const { token } = (await res.json()) as { token: string };
    const payload = decodePayload(token);
    expect(payload.sub).toBe(environment.id);
    expect(payload.pub).toBe(true);
    expect(payload.scopes).toEqual(["read:runs"]);

    // exp must be roughly now + 1h, well under the 24h cap.
    const nowSec = Math.floor(Date.now() / 1000);
    const exp = payload.exp as number;
    expect(exp).toBeGreaterThan(nowSec);
    expect(exp).toBeLessThanOrEqual(nowSec + 60 * 60 + 60);
  });

  it("rejects an uncapped expirationTime (100y) with 400", async () => {
    const server = getTestServer();
    const { apiKey } = await seedTestEnvironment(server.prisma);

    const res = await mint(apiKey, {
      claims: { scopes: ["read:runs"] },
      expirationTime: "100y",
    });
    expect(res.status).toBe(400);
  });

  it("rejects an expirationTime beyond 24h with 400", async () => {
    const server = getTestServer();
    const { apiKey } = await seedTestEnvironment(server.prisma);

    const res = await mint(apiKey, { expirationTime: "48h" });
    expect(res.status).toBe(400);
  });

  it("rejects a past expirationTime with 400", async () => {
    const server = getTestServer();
    const { apiKey } = await seedTestEnvironment(server.prisma);

    // Absolute epoch timestamp in the past.
    const past = Math.floor(Date.now() / 1000) - 60;
    const res = await mint(apiKey, { expirationTime: past });
    expect(res.status).toBe(400);
  });

  it("refuses to mint from a revoked (grace-window) key with 401", async () => {
    const server = getTestServer();
    const { apiKey, environment } = await seedTestEnvironment(server.prisma);

    // Sanity: the live key mints.
    const before = await mint(apiKey, { expirationTime: "1h" });
    expect(before.status).toBe(200);

    // Rotate exactly as regenerate-api-key does: new value on the env, old
    // value parked in RevokedApiKey with a future grace expiry. The old key
    // still authenticates elsewhere (grace window, by design) but must not
    // mint new JWTs.
    await server.prisma.$transaction([
      server.prisma.revokedApiKey.create({
        data: {
          apiKey,
          runtimeEnvironmentId: environment.id,
          expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000), // +1 day
        },
      }),
      server.prisma.runtimeEnvironment.update({
        where: { id: environment.id },
        data: { apiKey: `tr_dev_rotated_${Math.random().toString(36).slice(2)}` },
      }),
    ]);

    const res = await mint(apiKey, {
      claims: { scopes: ["read:runs"] },
      expirationTime: "1h",
    });
    expect(res.status).toBe(401);
  });
});
