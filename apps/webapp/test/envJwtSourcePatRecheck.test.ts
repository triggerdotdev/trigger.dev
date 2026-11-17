// An env JWT exchanged from a PAT (or from a user-actor token minted from one) names its source
// PAT, and both host JWT verifiers recheck it on every use, through a shared 60s cache: revoking,
// expiring or idling the PAT ends the JWT within that window, not just the PAT. Real token rows
// in a real Postgres, minted through the real exchange route; only the database client (pointed
// at the test database) and a few env values are substituted.
import type { PrismaClient } from "@trigger.dev/database";
import { generateJWT, validateJWT } from "@trigger.dev/core/v3/jwt";
import { createSourcePersonalAccessTokenCodec, SOURCE_PAT_CHECK_TTL_MS } from "@trigger.dev/rbac";
import { postgresTest } from "@internal/testcontainers";
import { describe, expect, vi } from "vitest";
import { seedTestUserProject } from "./helpers/seedTestUserProject";

vi.setConfig({ testTimeout: 60_000 });

const db = vi.hoisted(() => ({ client: null as unknown as PrismaClient }));

vi.mock("~/db.server", async () => {
  const { boundedIn } = await import("@trigger.dev/database");
  const client = new Proxy(
    {},
    {
      get(_target, prop) {
        const value = (db.client as any)[prop];
        return typeof value === "function" ? value.bind(db.client) : value;
      },
    }
  );
  return { prisma: client, $replica: client, boundedIn };
});

// Only the values these routes read. The real env module is never imported (see the
// trigger-tests skill): it validates the whole process environment at import.
vi.mock("~/env.server", async () => {
  const { withLegacyEncryptionKeyring } = await import("./helpers/encryptionEnv");
  return {
    env: withLegacyEncryptionKeyring({
      SESSION_SECRET: "test-session-secret-for-env-jwt-recheck",
      ENCRYPTION_KEY: "0123456789abcdef0123456789abcdef",
      APP_ORIGIN: "https://dashboard.example.test",
      // The built-in RBAC fallback, on the test database.
      RBAC_FORCE_FALLBACK: true,
      PERSONAL_ACCESS_TOKEN_EXPIRY_DAYS: [30, 90, 365],
      PERSONAL_ACCESS_TOKEN_DEFAULT_EXPIRY_DAYS: 90,
    }),
  };
});

import { action as envJwtAction } from "~/routes/api.v1.projects.$projectRef.$env.jwt";
import { action as userActorTokenAction } from "~/routes/api.v1.auth.user-actor-token";
import { validatePublicJwtKey } from "~/services/realtime/jwtAuth.server";
import { rbac } from "~/services/rbac.server";
import { handlePublicTokenRequest } from "~/services/publicTokens.server";
import { generateRootApiKey } from "~/utils/apiKeys";
import { createPersonalAccessToken } from "~/services/personalAccessToken.server";
import {
  inheritedSourcePatClaim,
  publicAccessTokenResponseHeaders,
} from "~/services/publicAccessTokenResponse.server";
import { mintSessionToken } from "~/services/realtime/mintSessionToken.server";
import { sourcePersonalAccessTokens } from "~/services/publicTokenSubject.server";

const DAY_MS = 24 * 60 * 60 * 1000;

async function seed(prisma: PrismaClient) {
  db.client = prisma;
  const seeded = await seedTestUserProject(prisma);
  // Created through the service so it's encrypted with this test's key.
  const created = await createPersonalAccessToken({
    name: "ci",
    userId: seeded.user.id,
    expiresInDays: 30,
  });
  return { ...seeded, pat: { token: created.token, id: created.id } };
}

async function postJson(handler: unknown, path: string, bearer: string, params = {}) {
  const response: Response = await (handler as any)({
    request: new Request(`https://api.example.test${path}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${bearer}`, "Content-Type": "application/json" },
      body: JSON.stringify({}),
    }),
    params,
    context: {},
  });
  expect(response.status).toBe(200);
  return (await response.json()) as { token: string };
}

/** Exchange a PAT or user-actor token for a dev env JWT through the real route. */
async function exchange(bearer: string, projectRef: string) {
  const { token } = await postJson(envJwtAction, `/api/v1/projects/${projectRef}/dev/jwt`, bearer, {
    projectRef,
    env: "dev",
  });
  return token;
}

/** The route builder's verifier (`rbac.authenticateBearer`, host JWT path). */
async function routeBuilderAccepts(jwt: string) {
  const result = await rbac.authenticateBearer(
    new Request("https://api.example.test/api/v1/runs", {
      headers: { Authorization: `Bearer ${jwt}` },
    }),
    { allowJWT: true }
  );
  return result.ok;
}

/** The legacy and realtime verifier. */
async function realtimeAccepts(jwt: string) {
  return (await validatePublicJwtKey(jwt)).ok;
}

const VERIFIERS: Array<[name: string, accepts: (jwt: string) => Promise<boolean>]> = [
  ["route builder", routeBuilderAccepts],
  ["realtime", realtimeAccepts],
];

/** Whether each host verifier accepts the JWT. */
async function accepted(jwt: string) {
  return { routeBuilder: await routeBuilderAccepts(jwt), realtime: await realtimeAccepts(jwt) };
}

function payloadOf(jwt: string) {
  return JSON.parse(Buffer.from(jwt.split(".")[1]!, "base64url").toString());
}

/** The token's `act.pat` is the PAT's id, sealed: the raw id appears nowhere in the token. */
function expectSealedSourcePat(jwt: string, patId: string) {
  const pat = payloadOf(jwt).act?.pat;
  expect(typeof pat).toBe("string");
  expect(sourcePersonalAccessTokens.decode(pat)).toBe(patId);
  expect(JSON.stringify(payloadOf(jwt))).not.toContain(patId);
}

/** Catches: the exchange not recording its source, so nothing could recheck it. */
postgresTest("an env JWT exchanged from a PAT names its source PAT", async ({ prisma }) => {
  const { project, pat } = await seed(prisma);

  const jwt = await exchange(pat.token, project.externalRef);

  expectSealedSourcePat(jwt, pat.id);
});

// Each test uses its own PAT and asks one verifier, so that verifier does its own lookup rather
// than reading an answer the other one cached.
for (const [name, accepts] of VERIFIERS) {
  describe(`${name}: an env JWT exchanged from a PAT`, () => {
    /** Catches: the recheck rejecting a JWT whose PAT is fine. */
    postgresTest("is accepted while the PAT is live", async ({ prisma }) => {
      const { project, pat } = await seed(prisma);
      const jwt = await exchange(pat.token, project.externalRef);

      expect(await accepts(jwt)).toBe(true);
    });

    /** Catches: a revoked PAT's JWT still working until it expires. */
    postgresTest("stops working once the PAT is revoked", async ({ prisma }) => {
      const { project, pat } = await seed(prisma);
      const jwt = await exchange(pat.token, project.externalRef);

      await prisma.personalAccessToken.update({
        where: { id: pat.id },
        data: { revokedAt: new Date() },
      });

      expect(await accepts(jwt)).toBe(false);
    });

    /** Catches: the recheck ignoring expiry (only looking at revokedAt). */
    postgresTest("stops working once the PAT expires", async ({ prisma }) => {
      const { project, pat } = await seed(prisma);
      const jwt = await exchange(pat.token, project.externalRef);

      await prisma.personalAccessToken.update({
        where: { id: pat.id },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });

      expect(await accepts(jwt)).toBe(false);
    });

    /** Catches: the recheck ignoring a CLI login's idle timeout. */
    postgresTest("stops working once the CLI login goes idle", async ({ prisma }) => {
      const { project, pat } = await seed(prisma);
      const jwt = await exchange(pat.token, project.externalRef);

      await prisma.personalAccessToken.update({
        where: { id: pat.id },
        data: {
          idleTimeoutSeconds: 7 * 24 * 60 * 60,
          lastAccessedAt: new Date(Date.now() - 8 * DAY_MS),
        },
      });

      expect(await accepts(jwt)).toBe(false);
    });
  });
}

describe("an env JWT exchanged from a user-actor token", () => {
  /**
   * Catches: a UAT exchange not carrying the UAT's source PAT onto the JWT, and the cached
   * check holding a revoked PAT's answer past its window.
   */
  postgresTest(
    "names the UAT's source PAT and dies with it once the cached check expires",
    async ({ prisma }) => {
      const { project, pat } = await seed(prisma);
      const { token: uat } = await postJson(
        userActorTokenAction,
        "/api/v1/auth/user-actor-token",
        pat.token
      );
      const jwt = await exchange(uat, project.externalRef);

      expectSealedSourcePat(jwt, pat.id);
      expect(await accepted(jwt)).toEqual({ routeBuilder: true, realtime: true });

      await prisma.personalAccessToken.update({
        where: { id: pat.id },
        data: { revokedAt: new Date() },
      });

      // Both verifiers share the cached answer from the use above, for the window.
      expect(await accepted(jwt)).toEqual({ routeBuilder: true, realtime: true });

      // Only the clock moves; timers and the database are real.
      vi.useFakeTimers({ toFake: ["Date"] });
      try {
        vi.setSystemTime(Date.now() + SOURCE_PAT_CHECK_TTL_MS);
        expect(await accepted(jwt)).toEqual({ routeBuilder: false, realtime: false });
      } finally {
        vi.useRealTimers();
      }
    }
  );
});

/** How the route builder hands a request's delegation actor to the handler. */
async function requestActor(jwt: string) {
  const result = await rbac.authenticateBearer(
    new Request("https://api.example.test/api/v1/tasks/hello/trigger", {
      headers: { Authorization: `Bearer ${jwt}` },
    }),
    { allowJWT: true }
  );
  if (!result.ok) throw new Error(`JWT rejected: ${result.error}`);
  return result.jwt?.act;
}

// Triggering, batch triggering and creating a session with a JWT mint a new run, batch or
// session token for the caller. Those routes pass the request's actor to these minters, so a
// token minted for a PAT-derived JWT names the same PAT and ends with it. That each route does
// pass it is checked against the real routes in patDerivedChildTokens.e2e.test.ts.
describe("a token minted for a request authenticated by a PAT-derived JWT", () => {
  const MINTERS: Array<
    [
      name: string,
      mint: (
        environment: Awaited<ReturnType<typeof seed>>["environment"],
        actor: Awaited<ReturnType<typeof requestActor>>
      ) => Promise<string>,
    ]
  > = [
    [
      "session token",
      (environment, actor) => mintSessionToken(environment, "session_x", { actor }),
    ],
    [
      "batch token",
      async (environment, actor) =>
        (
          await publicAccessTokenResponseHeaders({
            environment,
            scopes: ["read:batch:batch_x"],
            expirationTime: "1h",
            actor,
          })
        )["x-trigger-jwt"]!,
    ],
  ];

  for (const [name, mint] of MINTERS) {
    /** Catches: a child token surviving the PAT for its own lifetime (up to 1h). */
    postgresTest(`${name}: names the source PAT and ends with it`, async ({ prisma }) => {
      const { project, environment, pat } = await seed(prisma);
      const parent = await exchange(pat.token, project.externalRef);
      const actor = await requestActor(parent);
      expect(sourcePersonalAccessTokens.decode(actor!.pat!)).toBe(pat.id);

      const child = await mint(environment, actor);
      // Only the sealed PAT carries over: no user id in a token that may reach a browser.
      expect(payloadOf(child).act).toEqual({ pat: actor!.pat });
      expectSealedSourcePat(child, pat.id);
      expect(JSON.stringify(payloadOf(child))).not.toContain(actor!.sub);

      await prisma.personalAccessToken.update({
        where: { id: pat.id },
        data: { revokedAt: new Date() },
      });

      // Authenticating the parent cached the PAT as live; the child ends once that expires.
      vi.useFakeTimers({ toFake: ["Date"] });
      try {
        vi.setSystemTime(Date.now() + SOURCE_PAT_CHECK_TTL_MS);
        expect(await accepted(child)).toEqual({ routeBuilder: false, realtime: false });
      } finally {
        vi.useRealTimers();
      }
    });
  }

  /** Catches: stamping an act on tokens whose request had no source PAT. */
  postgresTest("adds nothing when the request has no source PAT", async ({ prisma }) => {
    const { environment } = await seed(prisma);

    const child = await mintSessionToken(environment, "session_x", {
      actor: { sub: "usr_1", client: "personal-access-token" },
    });

    expect(payloadOf(child).act).toBeUndefined();
    expect(inheritedSourcePatClaim(undefined)).toEqual({});
  });
});

describe("a public JWT whose source PAT claim doesn't open", () => {
  const CLAIMS: Array<[name: string, pat: (patId: string) => string]> = [
    ["a raw PAT id", (patId) => patId],
    [
      "a PAT sealed under another key",
      (patId) => createSourcePersonalAccessTokenCodec("another-secret").encode(patId),
    ],
  ];

  for (const [name, pat] of CLAIMS) {
    /** Catches: an unreadable `act.pat` being treated as "no source PAT" instead of failing closed. */
    postgresTest(`is rejected (${name})`, async ({ prisma }) => {
      const { environment, pat: livePat } = await seed(prisma);
      const jwt = await generateJWT({
        secretKey: environment.apiKey,
        payload: { sub: environment.id, pub: true, act: { sub: "usr_1", pat: pat(livePat.id) } },
        expirationTime: "15m",
      });

      expect(await accepted(jwt)).toEqual({ routeBuilder: false, realtime: false });
    });
  }
});

describe("public tokens minted during root-key rotation", () => {
  for (const branchName of [undefined, "root-rotation-branch"]) {
    // Catches: an old root minting replacement-key tokens that survive grace or immediate revocation.
    postgresTest(
      `preserves revocation for ${branchName ? "a branch" : "the root environment"}`,
      async ({ prisma }) => {
        db.client = prisma;
        const { environment: parent } = await seedTestUserProject(prisma);
        let targetEnvironmentId = parent.id;
        if (branchName) {
          const branchKey = generateRootApiKey("DEVELOPMENT").apiKey;
          const branch = await prisma.runtimeEnvironment.create({
            data: {
              slug: branchName,
              type: "DEVELOPMENT",
              branchName,
              parentEnvironmentId: parent.id,
              projectId: parent.projectId,
              organizationId: parent.organizationId,
              orgMemberId: parent.orgMemberId,
              apiKey: branchKey,
              pkApiKey: branchKey.replace(/^tr_/, "pk_"),
              shortcode: branchKey.slice(-8),
            },
          });
          targetEnvironmentId = branch.id;
        }

        const mint = (key: string) =>
          handlePublicTokenRequest(
            new Request("https://api.example.test/api/v1/auth/public-tokens", {
              method: "POST",
              headers: {
                Authorization: `Bearer ${key}`,
                "Content-Type": "application/json",
                ...(branchName ? { "x-trigger-branch": branchName } : {}),
              },
              body: JSON.stringify({ scopes: ["read:runs"], expirationTime: "1h" }),
            })
          );
        const mintToken = async (key: string) => {
          const response = await mint(key);
          expect(response.status).toBe(200);
          return ((await response.json()) as { token: string }).token;
        };

        const oldKey = parent.apiKey;
        const newKey = generateRootApiKey("DEVELOPMENT").apiKey;
        await prisma.revokedApiKey.create({
          data: {
            apiKey: oldKey,
            runtimeEnvironmentId: parent.id,
            expiresAt: new Date(Date.now() + DAY_MS),
          },
        });
        await prisma.runtimeEnvironment.update({
          where: { id: parent.id },
          data: { apiKey: newKey },
        });

        const oldToken = await mintToken(oldKey);
        const newToken = await mintToken(newKey);
        expect(await validateJWT(oldToken, oldKey)).toMatchObject({
          ok: true,
          payload: { sub: targetEnvironmentId },
        });
        expect((await validateJWT(oldToken, newKey)).ok).toBe(false);
        expect(await accepted(oldToken)).toEqual({ routeBuilder: true, realtime: true });
        expect(await accepted(newToken)).toEqual({ routeBuilder: true, realtime: true });

        await prisma.revokedApiKey.updateMany({
          where: { apiKey: oldKey, runtimeEnvironmentId: parent.id },
          data: { expiresAt: new Date(Date.now() - 1) },
        });
        expect((await mint(oldKey)).status).toBe(401);
        expect((await validateJWT(oldToken, oldKey)).ok).toBe(true);
        expect(await accepted(oldToken)).toEqual({ routeBuilder: false, realtime: false });
        expect(await accepted(newToken)).toEqual({ routeBuilder: true, realtime: true });

        // Immediate rotation retains no grace entry for the key being replaced.
        const immediateKey = generateRootApiKey("DEVELOPMENT").apiKey;
        await prisma.runtimeEnvironment.update({
          where: { id: parent.id },
          data: { apiKey: immediateKey },
        });
        expect((await mint(newKey)).status).toBe(401);
        expect(await accepted(newToken)).toEqual({ routeBuilder: false, realtime: false });
        expect(await accepted(await mintToken(immediateKey))).toEqual({
          routeBuilder: true,
          realtime: true,
        });
      }
    );
  }
});

describe("a public JWT that doesn't name a source PAT", () => {
  const PAYLOADS: Array<[name: string, extra: Record<string, unknown>]> = [
    // SDK public tokens and org access token exchanges.
    ["no act", {}],
    // Exchange JWTs minted before the claim existed.
    ["act without pat", { act: { sub: "usr_before", client: "personal-access-token" } }],
    ["a malformed act", { act: "usr_before" }],
    ["a non-string pat", { act: { sub: "usr_before", pat: 42 } }],
  ];

  for (const [name, extra] of PAYLOADS) {
    /** Catches: the recheck rejecting tokens that have no source PAT to check. */
    postgresTest(`is unaffected (${name})`, async ({ prisma }) => {
      const { environment } = await seed(prisma);
      const jwt = await generateJWT({
        secretKey: environment.apiKey,
        payload: { sub: environment.id, pub: true, scopes: ["read:runs"], ...extra },
        expirationTime: "15m",
      });

      expect(await accepted(jwt)).toEqual({ routeBuilder: true, realtime: true });
    });
  }
});
