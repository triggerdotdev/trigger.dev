// Cross-cutting auth-layer behaviours that aren't tied to a specific route
// family — see TRI-8743. Soft-deleted projects, revoked keys, expired JWTs,
// cross-env mismatch, force-fallback toggle.
//
// Strategy: pick one representative API-key route
// (GET /api/v1/runs/run_doesnotexist/result) and one representative JWT
// route (POST /api/v1/waitpoints/tokens/<id>/complete) and exercise the
// edge cases against those. The route choice doesn't matter — the
// auth layer is shared across every API route via apiBuilder.server.ts.
// Smoke matrix (api-auth.e2e.test.ts) already covers the trivial
// cases (missing/invalid key, basic JWT pass, soft-deleted project);
// this file adds cases that need explicit fixture setup.

import { generateJWT } from "@trigger.dev/core/v3/jwt";
import { SignJWT } from "jose";
import { describe, expect, it } from "vitest";
import { getTestServer } from "./helpers/sharedTestServer";
import { seedTestEnvironment } from "./helpers/seedTestEnvironment";

describe("Cross-cutting", () => {
  it("shared prisma client can read from the postgres container", async () => {
    const server = getTestServer();
    const count = await server.prisma.user.count();
    expect(count).toBeGreaterThanOrEqual(0);
  });

  // The auth path falls back to RevokedApiKey when a key isn't found
  // in RuntimeEnvironment — letting customers continue to use a key
  // for a configurable grace window after rotation. See
  // models/runtimeEnvironment.server.ts. The grace lookup matches by
  // (apiKey AND expiresAt > now) and rehydrates the env via the FK.
  describe("Revoked API key grace window", () => {
    const route = "/api/v1/runs/run_doesnotexist/result";

    it("revoked key within grace (expiresAt > now): auth passes", async () => {
      const server = getTestServer();
      const { environment } = await seedTestEnvironment(server.prisma);
      // Mint a fresh "rotated" key that doesn't exist on any env, then
      // record it as recently revoked with a future grace expiry.
      const rotatedKey = `tr_dev_rotated_${Math.random().toString(36).slice(2)}`;
      await server.prisma.revokedApiKey.create({
        data: {
          apiKey: rotatedKey,
          runtimeEnvironmentId: environment.id,
          expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000), // +1 day
        },
      });
      const res = await server.webapp.fetch(route, {
        headers: { Authorization: `Bearer ${rotatedKey}` },
      });
      // Auth passed — the route's resource lookup just doesn't find
      // run_doesnotexist. The point is NOT 401.
      expect(res.status).not.toBe(401);
    });

    it("revoked key past grace (expiresAt < now): 401", async () => {
      const server = getTestServer();
      const { environment } = await seedTestEnvironment(server.prisma);
      const expiredKey = `tr_dev_expired_${Math.random().toString(36).slice(2)}`;
      await server.prisma.revokedApiKey.create({
        data: {
          apiKey: expiredKey,
          runtimeEnvironmentId: environment.id,
          expiresAt: new Date(Date.now() - 60 * 1000), // -1 minute
        },
      });
      const res = await server.webapp.fetch(route, {
        headers: { Authorization: `Bearer ${expiredKey}` },
      });
      expect(res.status).toBe(401);
    });
  });

  // JWT edge cases beyond what the smoke matrix covers (which only
  // checks "wrong key" and "missing scope"). All target the same
  // representative JWT route — the JWT validator is shared across
  // routes via apiBuilder, so coverage here generalises.
  describe("JWT edge cases", () => {
    const route = "/api/v1/waitpoints/tokens/wp_does_not_exist/complete";

    async function postWithJwt(jwt: string) {
      const server = getTestServer();
      return server.webapp.fetch(route, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${jwt}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({}),
      });
    }

    it("JWT with expirationTime in the past: 401", async () => {
      const server = getTestServer();
      const { environment } = await seedTestEnvironment(server.prisma);
      // generateJWT only accepts string expirationTimes (relative, like
      // "15m"). To create a definitively-expired token use jose
      // directly with an absolute past timestamp.
      const secret = new TextEncoder().encode(environment.apiKey);
      const jwt = await new SignJWT({
        pub: true,
        sub: environment.id,
        scopes: ["write:waitpoints"],
      })
        .setIssuer("https://id.trigger.dev")
        .setAudience("https://api.trigger.dev")
        .setProtectedHeader({ alg: "HS256" })
        .setIssuedAt(0)
        .setExpirationTime(1) // 1970-01-01 — definitively expired
        .sign(secret);

      const res = await postWithJwt(jwt);
      expect(res.status).toBe(401);
    });

    it("JWT with pub: false: 401", async () => {
      const server = getTestServer();
      const { environment } = await seedTestEnvironment(server.prisma);
      const jwt = await generateJWT({
        secretKey: environment.apiKey,
        payload: { pub: false, sub: environment.id, scopes: ["write:waitpoints"] },
        expirationTime: "15m",
      });
      // pub: false means "this token isn't meant for client-side use"
      // — the auth layer rejects it for the same-class JWT routes.
      const res = await postWithJwt(jwt);
      expect(res.status).toBe(401);
    });

    it("JWT with no sub claim: 401", async () => {
      const server = getTestServer();
      const { environment } = await seedTestEnvironment(server.prisma);
      const jwt = await generateJWT({
        secretKey: environment.apiKey,
        payload: { pub: true, scopes: ["write:waitpoints"] },
        expirationTime: "15m",
      });
      // No sub claim — auth can't resolve which env the token belongs
      // to, so it must reject. (sub carries the env id.)
      const res = await postWithJwt(jwt);
      expect(res.status).toBe(401);
    });

    it("JWT signed with another env's apiKey (cross-env): 401", async () => {
      const server = getTestServer();
      // env A's id but signed with env B's apiKey — sub-vs-signature
      // mismatch the auth layer must catch.
      const a = await seedTestEnvironment(server.prisma);
      const b = await seedTestEnvironment(server.prisma);
      const jwt = await generateJWT({
        secretKey: b.apiKey, // <-- WRONG key relative to the sub claim
        payload: { pub: true, sub: a.environment.id, scopes: ["write:waitpoints"] },
        expirationTime: "15m",
      });
      const res = await postWithJwt(jwt);
      expect(res.status).toBe(401);
    });

    it("JWT malformed (three parts but invalid base64 in payload): 401", async () => {
      // Three "."-separated parts so the JWT shape gate sees it as a
      // candidate, but the payload segment is non-base64 garbage.
      // Validator must surface this as 401, not 500.
      const malformed = "eyJhbGciOiJIUzI1NiJ9.@@@notbase64@@@.signature";
      const res = await postWithJwt(malformed);
      expect(res.status).toBe(401);
    });
  });

  // The auth layer resolves the JWT's env from the `sub` claim — NOT
  // from the route path. So a JWT for env A hitting a route that
  // fetches a resource from env B should never accidentally see env
  // B's data. Test by minting a JWT for env A and asking for a
  // resource that lives in env B — expect 404 (not 200).
  describe("Cross-environment: JWT auth resolves env from sub, not URL", () => {
    it("env A's JWT cannot read env B's resource: 404", async () => {
      const server = getTestServer();
      const a = await seedTestEnvironment(server.prisma);
      const b = await seedTestEnvironment(server.prisma);

      // Seed a real-ish run row in env B so the route would have
      // something to find IF auth resolved the env from the URL.
      const friendlyId = `run_${Math.random().toString(36).slice(2, 10)}`;
      await server.prisma.taskRun.create({
        data: {
          friendlyId,
          taskIdentifier: "test-task",
          payload: "{}",
          payloadType: "application/json",
          traceId: `trace_${Math.random().toString(36).slice(2)}`,
          spanId: `span_${Math.random().toString(36).slice(2)}`,
          runtimeEnvironmentId: b.environment.id,
          projectId: b.project.id,
          organizationId: b.organization.id,
          engine: "V2",
          status: "COMPLETED_SUCCESSFULLY",
        },
      });

      const jwt = await generateJWT({
        secretKey: a.apiKey,
        payload: { pub: true, sub: a.environment.id, scopes: ["read:runs"] },
        expirationTime: "15m",
      });

      const res = await server.webapp.fetch(`/api/v1/runs/${friendlyId}/result`, {
        headers: { Authorization: `Bearer ${jwt}` },
      });
      // The route resolves runs scoped to the JWT's env (env A). The
      // run lives in env B, so env A's view returns "not found" —
      // critically, NOT 200.
      expect(res.status).not.toBe(200);
      expect([401, 404]).toContain(res.status);
    });
  });
});
