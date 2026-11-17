import {
  createStandalonePostgresContainer,
  MinIOContainer,
  type StartedMinIOContainer,
} from "@internal/testcontainers";
import { generateJWT, validateJWT } from "@trigger.dev/core/v3/jwt";
import { createHash, randomBytes } from "node:crypto";
import { metrics } from "@opentelemetry/api";
import { createInMemoryMetrics } from "./utils/tracing";
import { decodeJwt, exportJWK, generateKeyPair, SignJWT } from "jose";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createRedisContainer } from "../../../internal-packages/testcontainers/src/utils";
import { seedTestEnvironment } from "./helpers/seedTestEnvironment";
import { seedTestRun } from "./helpers/seedTestRun";
import { seedTestApiSession } from "./helpers/seedTestApiSession";
import { seedTestPAT, seedTestUser } from "./helpers/seedTestPAT";
import { assertRunTokenSchedules } from "./helpers/assertRunTokenSchedules";
import { assertRunTokenWaitpoints } from "./helpers/assertRunTokenWaitpoints";

import type * as Database from "~/db.server";
import type * as V1 from "~/routes/api.v1.packets.$";
import type * as V2 from "~/routes/api.v2.packets.$";

vi.unmock("~/v3/runEngine.server");

const ISSUER = "https://internal-token.example.com";
const KEY_ID = "packet-api-test";
let database: typeof Database;
let container: Awaited<ReturnType<typeof createStandalonePostgresContainer>>;
let minio: StartedMinIOContainer;
let redis: Awaited<ReturnType<typeof createRedisContainer>>;
let s2AccountServer: Server;
const issuedStreamScopes: { streams: { exact?: string; prefix?: string } }[] = [];
let privateKey: Awaited<ReturnType<typeof generateKeyPair>>["privateKey"];
let v1: typeof V1;
let v2: typeof V2;
let telemetryMetrics: ReturnType<typeof createInMemoryMetrics>;

beforeAll(async () => {
  telemetryMetrics = createInMemoryMetrics();
  metrics.disable();
  metrics.setGlobalMeterProvider(telemetryMetrics.meterProvider);
  container = await createStandalonePostgresContainer();
  minio = await new MinIOContainer().start();
  redis = await createRedisContainer({ port: 6379 });
  s2AccountServer = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    issuedStreamScopes.push(body.scope);
    response.writeHead(201, { "Content-Type": "application/json" });
    response.end(
      JSON.stringify({ access_token: `test-stream-token-${issuedStreamScopes.length}` })
    );
  });
  await new Promise<void>((resolve) => s2AccountServer.listen(0, "127.0.0.1", resolve));
  const s2Port = (s2AccountServer.address() as AddressInfo).port;
  vi.stubEnv("REDIS_HOST", redis.container.getHost());
  vi.stubEnv("REDIS_PORT", String(redis.container.getPort()));
  vi.stubEnv("REDIS_PASSWORD", redis.container.getPassword());
  vi.stubEnv("REDIS_TLS_DISABLED", "true");
  vi.stubEnv("RUN_ENGINE_WORKER_ENABLED", "0");
  vi.stubEnv("RUN_ENGINE_TTL_SYSTEM_DISABLED", "true");
  vi.stubEnv("RUN_ENGINE_TTL_CONSUMERS_DISABLED", "true");
  vi.stubEnv("SCHEDULE_WORKER_REDIS_HOST", redis.container.getHost());
  vi.stubEnv("SCHEDULE_WORKER_REDIS_PORT", String(redis.container.getPort()));
  vi.stubEnv("SCHEDULE_WORKER_REDIS_PASSWORD", redis.container.getPassword());
  vi.stubEnv("SCHEDULE_WORKER_REDIS_TLS_DISABLED", "true");
  vi.stubEnv("SCHEDULE_WORKER_ENABLED", "0");
  vi.stubEnv("REALTIME_STREAMS_REDIS_HOST", redis.container.getHost());
  vi.stubEnv("REALTIME_STREAMS_REDIS_PORT", String(redis.container.getPort()));
  vi.stubEnv("REALTIME_STREAMS_REDIS_PASSWORD", redis.container.getPassword());
  vi.stubEnv("REALTIME_STREAMS_REDIS_TLS_DISABLED", "true");
  vi.stubEnv("REALTIME_STREAMS_S2_ACCESS_TOKEN", "test-account-token");
  vi.stubEnv("REALTIME_STREAMS_S2_ACCOUNT_URL", `http://127.0.0.1:${s2Port}/v1`);
  vi.stubEnv("REALTIME_STREAMS_S2_BASIN", "run-token-test");
  const store = minio.getConnectionConfig();
  vi.stubEnv("DATABASE_URL", container.url);
  vi.stubEnv("DIRECT_URL", container.url);
  vi.stubEnv("MAGIC_LINK_SECRET", "packet-api-test-magic-link-secret");
  vi.stubEnv("ENCRYPTION_KEY", "test-encryption-key-for-e2e!!!!!");
  vi.stubEnv("DEPLOY_REGISTRY_HOST", "registry.example.com");
  vi.stubEnv("V4_DEPLOY_REGISTRY_HOST", "registry.example.com");
  vi.stubEnv("CLICKHOUSE_URL", "http://localhost:19123");
  vi.stubEnv("CONTROL_PLANE_DATABASE_URL", container.url);
  vi.stubEnv("DATABASE_READ_REPLICA_URL", container.url);
  vi.stubEnv("CONTROL_PLANE_DATABASE_READ_REPLICA_URL", container.url);
  vi.stubEnv("RBAC_FORCE_FALLBACK", "1");
  vi.stubEnv("RUN_TOKEN_ISSUER_URL", ISSUER);
  vi.stubEnv("OBJECT_STORE_DEFAULT_PROTOCOL", "s3");
  for (const prefix of ["OBJECT_STORE_", "OBJECT_STORE_S3_"]) {
    vi.stubEnv(`${prefix}BASE_URL`, store.baseUrl);
    vi.stubEnv(`${prefix}ACCESS_KEY_ID`, store.accessKeyId);
    vi.stubEnv(`${prefix}SECRET_ACCESS_KEY`, store.secretAccessKey);
    vi.stubEnv(`${prefix}REGION`, store.region);
    vi.stubEnv(`${prefix}SERVICE`, "s3");
  }
  database = await import("~/db.server");
  const keys = await generateKeyPair("RS256");
  privateKey = keys.privateKey;
  await database.prisma.oidcSigningKey.create({
    data: {
      kid: KEY_ID,
      purpose: "INTERNAL_RUN",
      status: "ACTIVE",
      publicJwk: JSON.parse(
        JSON.stringify({
          ...(await exportJWK(keys.publicKey)),
          kid: KEY_ID,
          alg: "RS256",
          use: "sig",
        })
      ),
      readyAt: new Date(),
      generatedByUserId: "packet-api-test",
    },
  });
  v1 = await import("~/routes/api.v1.packets.$");
  v2 = await import("~/routes/api.v2.packets.$");
}, 120_000);

afterAll(async () => {
  const { engine } = await import("~/v3/runEngine.server");
  await engine.quit();
  await telemetryMetrics?.shutdown();
  metrics.disable();
  await database?.$replica.$disconnect();
  await database?.prisma.$disconnect();
  await container?.container.stop();
  await minio?.stop({ timeout: 0 });
  await redis?.container.stop();
  if (s2AccountServer) await new Promise<void>((resolve) => s2AccountServer.close(() => resolve()));
  vi.unstubAllEnvs();
});

async function tokenFor(
  environment: { id: string; organizationId: string; projectId: string },
  scopes = ["admin"]
) {
  return new SignJWT({
    token_use: "run",
    org_id: environment.organizationId,
    project_id: environment.projectId,
    environment_id: environment.id,
    run_id: "run_packet_test",
    attempt: 1,
    scopes,
  })
    .setProtectedHeader({ alg: "RS256", kid: KEY_ID, typ: "run+jwt" })
    .setIssuer(ISSUER)
    .setAudience("trigger:api")
    .setSubject("run:run_packet_test")
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(privateKey);
}

function args(method: "GET" | "PUT", filename: string, bearer: string) {
  return {
    request: new Request("https://api.example.com/api/v2/packets/test", {
      method,
      headers: { Authorization: `Bearer ${bearer}` },
    }),
    params: { "*": filename },
    context: {},
  };
}

async function seedDeployedEnvironment() {
  const seed = await seedTestEnvironment(database.prisma);
  const environment = await database.prisma.runtimeEnvironment.update({
    where: { id: seed.environment.id },
    data: { type: "PRODUCTION", slug: "prod", apiKey: seed.apiKey.replace("tr_dev_", "tr_prod_") },
  });
  return { ...seed, environment };
}

async function packetReaderFor(environmentId: string) {
  const user = await seedTestUser(database.prisma);
  const key = `tr_prod_sk_${randomBytes(12).toString("hex")}`;
  await database.prisma.apiKey.create({
    data: {
      name: "Restricted packet reader",
      keyHash: createHash("sha256").update(key).digest("hex"),
      lastFour: key.slice(-4),
      runtimeEnvironmentId: environmentId,
      createdByUserId: user.id,
      scopes: ["read:packets"],
    },
  });
  return key;
}

describe("run-token API authorization", () => {
  it("creates usable preview and production waitpoint callbacks and public JWTs", async () => {
    await assertRunTokenWaitpoints(database.prisma, tokenFor);
  });

  // Catches: own-run waits requiring broad waitpoint grants or allowing foreign waitpoint access.
  it("creates and blocks scoped waits without granting access to existing waitpoints", async () => {
    const { environment, project, organization } = await seedDeployedEnvironment();
    const { run } = await seedTestRun(database.prisma, {
      environmentId: environment.id,
      projectId: project.id,
    });
    await database.prisma.taskRun.update({
      where: { id: run.id },
      data: { status: "EXECUTING", organizationId: organization.id },
    });
    await database.prisma.taskRunExecutionSnapshot.create({
      data: {
        engine: "V2",
        executionStatus: "EXECUTING",
        description: "Test run executing",
        runId: run.id,
        runStatus: "EXECUTING",
        environmentId: environment.id,
        environmentType: "PRODUCTION",
        projectId: project.id,
        organizationId: organization.id,
      },
    });
    // The scopes a sandbox run token carries for its own run and session.
    const scopes = [
      `read:runs:${run.friendlyId}`,
      `write:runs:${run.friendlyId}`,
      "read:sessions:scoped-session:in",
    ];
    const bearer = await tokenFor(environment, scopes);
    const post = (body: unknown) => {
      const json = JSON.stringify(body);
      return new Request("https://api.example.com/test", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${bearer}`,
          "Content-Type": "application/json",
          "Content-Length": String(Buffer.byteLength(json)),
        },
        body: json,
      });
    };
    const duration = await import("~/routes/engine.v1.runs.$runFriendlyId.wait.duration");
    const input = await import("~/routes/api.v1.runs.$runFriendlyId.input-streams.wait");
    const session = await import("~/routes/api.v1.runs.$runFriendlyId.session-streams.wait");
    const params = { runFriendlyId: run.friendlyId };
    const createToken = await import("~/routes/api.v1.waitpoints.tokens");
    const createBody = JSON.stringify({ idempotencyKey: "shared-key" });
    const standalone = await createToken.action({
      request: new Request("https://api.example.com/test", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${environment.apiKey}`,
          "Content-Type": "application/json",
          "Content-Length": String(Buffer.byteLength(createBody)),
        },
        body: createBody,
      }),
      params: {},
      context: {},
    });
    expect(standalone.status).toBe(200);
    const standaloneId = (await standalone.json()).id;
    const durationResult = await duration.action({
      request: post({ date: new Date(Date.now() + 60_000).toISOString() }),
      params,
      context: {},
    });
    expect(durationResult.status).toBe(200);
    const waitpointId = (await durationResult.json()).waitpoint.id;
    for (const [action, body] of [
      [input.action, { streamId: "approval", timeout: "1h", idempotencyKey: "shared-key" }],
      [session.action, { session: "scoped-session", io: "in", timeout: "1h" }],
    ] as const) {
      const response = await action({ request: post(body), params, context: {} });
      expect(response.status).toBe(200);
      const created = await response.json();
      expect(created).toMatchObject({ isBlocked: true });
      expect(created.waitpointId).not.toBe(standaloneId);
    }
    const complete =
      await import("~/routes/api.v1.waitpoints.tokens.$waitpointFriendlyId.complete");
    const denied = await complete.action({
      request: post({}),
      params: { waitpointFriendlyId: waitpointId },
      context: {},
    });
    expect(denied.status).toBe(403);
    expect(await denied.json()).toMatchObject({
      error: expect.stringContaining(`write:waitpoints:${waitpointId}`),
      code: "unauthorized",
      param: "access_token",
      type: "authorization",
    });
    const existing =
      await import("~/routes/engine.v1.runs.$runFriendlyId.waitpoints.tokens.$waitpointFriendlyId.wait");
    const readDenied = await existing.action({
      request: post({}),
      params: { ...params, waitpointFriendlyId: waitpointId },
      context: {},
    });
    expect(readDenied.status).toBe(403);
    const foreign = await duration.action({
      request: post({ date: new Date(Date.now() + 60_000).toISOString() }),
      params: { runFriendlyId: "run_other" },
      context: {},
    });
    expect(foreign.status).toBe(403);
    expect((await foreign.json()).error).toBe(
      "Unauthorized. Missing permission: write:runs:run_other"
    );
  });

  it("rejects run tokens on non-builder envvar and deployment routes and API-key-only auth", async () => {
    const { environment, project } = await seedDeployedEnvironment();
    const token = await tokenFor(environment);
    const envvars = await import("~/routes/api.v1.projects.$projectRef.envvars");
    const deployments = await import("~/routes/api.v1.deployments");
    const registry =
      await import("~/routes/api.v1.deployments.$deploymentId.generate-registry-credentials");
    const { authenticateApiKeyRequest } = await import("~/services/apiAuth.server");
    const request = (method = "GET") =>
      new Request("https://api.example.com/test", {
        method,
        headers: { Authorization: `Bearer ${token}` },
      });
    expect(
      (
        await envvars.loader({
          request: request(),
          params: { projectRef: project.externalRef },
          context: {},
        })
      ).status
    ).toBe(401);
    expect(
      (
        await deployments.action({
          request: request("POST"),
          params: {},
          context: {},
        })
      ).status
    ).toBe(401);
    expect(
      (
        await registry.action({
          request: request("POST"),
          params: { deploymentId: "deployment_test" },
          context: {},
        })
      ).status
    ).toBe(401);
    expect(await authenticateApiKeyRequest(request())).toMatchObject({ ok: false, status: 401 });
    expect(
      await authenticateApiKeyRequest(
        new Request("https://api.example.com/test", {
          headers: { Authorization: `Bearer ${environment.apiKey}` },
        })
      )
    ).toMatchObject({ ok: true });
  });

  it("preserves legacy public-JWT packet GET in every environment", async () => {
    const { environment } = await seedDeployedEnvironment();
    const token = await generateJWT({
      secretKey: environment.apiKey,
      payload: { sub: environment.id, pub: true, scopes: ["read:runs:run_legacy"] },
      expirationTime: "1h",
    });
    const upload = await (
      await v2.action(args("PUT", "legacy/output.json", environment.apiKey))
    ).json();
    await fetch(upload.presignedUrl, { method: "PUT", body: "legacy output" });
    const response = await v1.loader(args("GET", upload.storagePath, token));
    expect(response.status).toBe(200);
    expect(await (await fetch((await response.json()).presignedUrl)).text()).toBe("legacy output");
    expect((await v1.action(args("PUT", "legacy/output.json", token))).status).toBe(401);

    const dev = await seedTestEnvironment(database.prisma);
    const devToken = await generateJWT({
      secretKey: dev.environment.apiKey,
      payload: { sub: dev.environment.id, pub: true, scopes: ["read:packets"] },
      expirationTime: "1h",
    });
    expect((await v1.loader(args("GET", "shared/output.json", devToken))).status).toBe(200);
  });

  it("preserves MCP's real PAT exchange and dashboard abilities with live membership", async () => {
    const { environment, organization, project } = await seedDeployedEnvironment();
    const user = await seedTestUser(database.prisma);
    const membership = await database.prisma.orgMember.create({
      data: { organizationId: organization.id, userId: user.id, role: "MEMBER" },
    });
    const pat = await seedTestPAT(database.prisma, user.id);
    const exchange = await import("~/routes/api.v1.projects.$projectRef.$env.jwt");
    const dashboards = await import("~/routes/api.v1.query.dashboards._index");
    const mint = async (scopes: string[]) => {
      const response = await exchange.action({
        request: new Request("https://api.example.com/jwt", {
          method: "POST",
          headers: { Authorization: `Bearer ${pat.token}`, "Content-Type": "application/json" },
          body: JSON.stringify({ claims: { scopes } }),
        }),
        params: { projectRef: project.externalRef, env: "prod" },
        context: {},
      });
      expect(response.status).toBe(200);
      return (await response.json()).token as string;
    };
    const list = (bearer: string) =>
      dashboards.loader({
        request: new Request("https://api.example.com/api/v1/query/dashboards", {
          headers: { Authorization: `Bearer ${bearer}` },
        }),
        params: {},
        context: {},
      });
    const create = (bearer: string) =>
      dashboards.action({
        request: new Request("https://api.example.com/api/v1/query/dashboards", {
          method: "POST",
          headers: { Authorization: `Bearer ${bearer}`, "Content-Type": "application/json" },
          body: JSON.stringify({ title: "MCP dashboard" }),
        }),
        params: {},
        context: {},
      });
    const token = await mint(["read:query", "write:query"]);
    expect((await list(token)).status).toBe(200);
    expect((await create(token)).status).toBe(201);
    const readOnly = await mint(["read:query"]);
    expect((await list(readOnly)).status).toBe(200);
    expect((await create(readOnly)).status).toBe(403);

    const runToken = await tokenFor(environment);
    expect((await list(runToken)).status).toBe(403);
    const { handlePublicTokenRequest } = await import("~/services/publicTokens.server");
    const delegated = await handlePublicTokenRequest(
      new Request("https://api.example.com/public-tokens", {
        method: "POST",
        headers: { Authorization: `Bearer ${runToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ scopes: ["read:query"], act: { sub: user.id } }),
      })
    );
    expect(delegated.status).toBe(200);
    const publicToken = (await delegated.json()).token;
    expect(decodeJwt(publicToken).act).toBeUndefined();
    expect((await list(publicToken)).status).toBe(403);
    await database.prisma.orgMember.delete({ where: { id: membership.id } });
    expect((await list(token)).status).toBe(403);
  });

  // Catches: a root key holder naming any user on a public JWT and being treated as that user.
  it("verifies the user on a PAT-exchanged JWT but not on a self-signed one", async () => {
    const { environment, organization, project } = await seedDeployedEnvironment();
    const user = await seedTestUser(database.prisma);
    await database.prisma.orgMember.create({
      data: { organizationId: organization.id, userId: user.id, role: "MEMBER" },
    });
    const pat = await seedTestPAT(database.prisma, user.id);
    const exchange = await import("~/routes/api.v1.projects.$projectRef.$env.jwt");
    const { createLoaderApiRoute } = await import("~/services/routeBuilders/apiBuilder.server");
    const route = createLoaderApiRoute(
      {
        allowJWT: true,
        findResource: async () => ({ type: "runs", id: "run_actor" }),
        authorization: { action: "read", resource: (resource) => resource },
      },
      async ({ authentication }) => new Response(JSON.stringify({ actor: authentication.actor }))
    );
    const actorFor = async (bearer: string) =>
      (
        await (
          await route({
            request: new Request("https://api.example.com/actor", {
              headers: { Authorization: `Bearer ${bearer}` },
            }),
            params: {},
            context: {},
          })
        ).json()
      ).actor;

    const exchanged = await exchange.action({
      request: new Request("https://api.example.com/jwt", {
        method: "POST",
        headers: { Authorization: `Bearer ${pat.token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ claims: { scopes: ["read:runs"] } }),
      }),
      params: { projectRef: project.externalRef, env: "prod" },
      context: {},
    });
    expect(exchanged.status).toBe(200);
    const selfSigned = await generateJWT({
      secretKey: environment.apiKey,
      payload: { pub: true, sub: environment.id, scopes: ["read:runs"], act: { sub: user.id } },
      expirationTime: "1h",
    });

    expect(await actorFor((await exchanged.json()).token)).toEqual({
      sub: user.id,
      client: "personal-access-token",
      // The sealed source PAT, which revoking the PAT checks against.
      pat: expect.any(String),
      verified: true,
    });
    // Existing readers still get the user; only `verified` tells the two apart.
    expect(await actorFor(selfSigned)).toEqual({ sub: user.id, verified: false });
  });

  // Catches: the legacy PUBLIC_JWT path (the API rate limiter's) checking the signature against
  // anything other than the token's own environment, expiry and scopes.
  it("verifies a PAT-exchanged JWT's user on the legacy path only with the claims it was minted with", async () => {
    const { environment, organization, project } = await seedDeployedEnvironment();
    const { environment: otherEnvironment } = await seedDeployedEnvironment();
    const user = await seedTestUser(database.prisma);
    await database.prisma.orgMember.create({
      data: { organizationId: organization.id, userId: user.id, role: "MEMBER" },
    });
    const pat = await seedTestPAT(database.prisma, user.id);
    const exchange = await import("~/routes/api.v1.projects.$projectRef.$env.jwt");
    const { authenticateApiKey } = await import("~/services/apiAuth.server");

    const exchanged = await exchange.action({
      request: new Request("https://api.example.com/jwt", {
        method: "POST",
        headers: { Authorization: `Bearer ${pat.token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ claims: { scopes: ["read:runs"] } }),
      }),
      params: { projectRef: project.externalRef, env: "prod" },
      context: {},
    });
    expect(exchanged.status).toBe(200);
    const { token } = (await exchanged.json()) as { token: string };
    const { act, exp } = decodeJwt(token) as { act: Record<string, unknown>; exp: number };
    // The minted `act`, signature included, on a token with other claims. Only a root key holder
    // can sign one of these, as here.
    const resigned = (
      target: { id: string; apiKey: string },
      claims: { scopes: string[]; exp: number }
    ) =>
      generateJWT({
        secretKey: target.apiKey,
        payload: { pub: true, sub: target.id, scopes: claims.scopes, act },
        expirationTime: claims.exp,
      });
    const actorFor = async (bearer: string) =>
      (await authenticateApiKey(bearer, { allowJWT: true, clientIp: null }))?.actor;

    expect(await actorFor(token)).toMatchObject({ sub: user.id, verified: true });
    // Control: the minted claims, re-signed unchanged, still verify.
    expect(
      await actorFor(await resigned(environment, { scopes: ["read:runs"], exp }))
    ).toMatchObject({ sub: user.id, verified: true });
    expect(
      await actorFor(await resigned(environment, { scopes: ["read:runs", "write:all"], exp }))
    ).toMatchObject({ sub: user.id, verified: false });
    expect(
      await actorFor(await resigned(otherEnvironment, { scopes: ["read:runs"], exp }))
    ).toMatchObject({ sub: user.id, verified: false });
    expect(
      await actorFor(await resigned(environment, { scopes: ["read:runs"], exp: exp + 60 }))
    ).toMatchObject({ sub: user.id, verified: false });
  });

  it("retains restricted additional-key query and dashboard behavior without widening run tokens", async () => {
    const { environment } = await seedDeployedEnvironment();
    const user = await seedTestUser(database.prisma);
    const key = `tr_prod_sk_${randomBytes(12).toString("hex")}`;
    await database.prisma.apiKey.create({
      data: {
        name: "Restricted query key",
        keyHash: createHash("sha256").update(key).digest("hex"),
        lastFour: key.slice(-4),
        runtimeEnvironmentId: environment.id,
        createdByUserId: user.id,
        scopes: ["read:query"],
      },
    });
    const { createLoaderApiRoute } = await import("~/services/routeBuilders/apiBuilder.server");
    const { queryScopeCeilingFor, resolveQueryScope } = await import("~/v3/queryScope");
    const route = createLoaderApiRoute(
      {
        findResource: async () => ({ type: "query", id: "runs" }),
        authorization: { action: "read", resource: (resource) => resource },
      },
      async ({ authentication }) =>
        new Response(
          JSON.stringify({
            credentialKind: authentication.credentialKind,
            environmentScoped: authentication.environmentScoped,
            scope: resolveQueryScope({
              ceiling: queryScopeCeilingFor(authentication),
              requested: "organization",
            }),
          })
        )
    );
    const call = (bearer: string) =>
      route({
        request: new Request("https://api.example.com/query", {
          headers: { Authorization: `Bearer ${bearer}` },
        }),
        params: {},
        context: {},
      });
    expect(await (await call(key)).json()).toMatchObject({
      credentialKind: "additional_api_key",
      environmentScoped: true,
      scope: { ok: true, scope: "organization" },
    });
    expect(await (await call(await tokenFor(environment))).json()).toMatchObject({
      credentialKind: "run_token",
      environmentScoped: true,
      scope: { ok: false },
    });
    const dashboards = await import("~/routes/api.v1.query.dashboards._index");
    expect(
      (
        await dashboards.loader({
          request: new Request("https://api.example.com/dashboards", {
            headers: { Authorization: `Bearer ${key}` },
          }),
          params: {},
          context: {},
        })
      ).status
    ).toBe(200);
  });

  it("checks run-token branches only in branchable environments without retargeting", async () => {
    const seed = await seedTestEnvironment(database.prisma);
    const { createLoaderApiRoute } = await import("~/services/routeBuilders/apiBuilder.server");
    const route = createLoaderApiRoute(
      {
        findResource: async () => ({ type: "runs" }),
        authorization: { action: "read", resource: (resource) => resource },
      },
      async ({ authentication }) => new Response(authentication.environment.id)
    );
    const call = async (environment: typeof seed.environment, branch?: string) => {
      const token = await tokenFor(environment);
      return route({
        request: new Request("https://api.example.com/runs", {
          headers: {
            Authorization: `Bearer ${token}`,
            ...(branch !== undefined ? { "x-trigger-branch": branch } : {}),
          },
        }),
        params: {},
        context: {},
      });
    };
    expect(await (await call(seed.environment)).text()).toBe(seed.environment.id);
    expect((await call(seed.environment, "default")).status).toBe(200);
    expect((await call(seed.environment, "other")).status).toBe(401);
    expect((await call(seed.environment, "refs/invalid")).status).toBe(401);
    const devChild = await database.prisma.runtimeEnvironment.create({
      data: {
        organizationId: seed.organization.id,
        projectId: seed.project.id,
        type: "DEVELOPMENT",
        slug: "dev",
        branchName: "feature",
        shortcode: "dev-child",
        apiKey: `${seed.apiKey}_child`,
        pkApiKey: `${seed.environment.pkApiKey}_child`,
        parentEnvironmentId: seed.environment.id,
      },
    });
    expect((await call(devChild)).status).toBe(200);
    expect((await call(devChild, "refs/heads/feature")).status).toBe(200);
    expect((await call(devChild, "default")).status).toBe(401);
    const parent = await database.prisma.runtimeEnvironment.update({
      where: { id: seed.environment.id },
      data: { type: "PREVIEW", slug: "preview" },
    });
    const preview = await database.prisma.runtimeEnvironment.update({
      where: { id: devChild.id },
      data: { type: "PREVIEW", slug: "preview-default", branchName: "default" },
    });
    expect((await call(parent)).status).toBe(200);
    expect((await call(parent, "default")).status).toBe(401);
    expect((await call(preview)).status).toBe(200);
    expect((await call(preview, "default")).status).toBe(200);
    // Catches: explicit preview-tier envvar calls rejecting their own branch token.
    const envvars = await import("~/routes/api.v1.projects.$projectRef.envvars.$slug");
    expect(
      (
        await envvars.loader({
          request: new Request("https://api.example.com/envvars", {
            headers: {
              Authorization: `Bearer ${await tokenFor(preview)}`,
              "x-trigger-branch": "default",
            },
          }),
          params: { projectRef: seed.project.externalRef, slug: "preview" },
          context: {},
        })
      ).status
    ).toBe(200);
    expect((await call(preview, "feature")).status).toBe(401);
    expect((await call(preview, "refs/invalid")).status).toBe(401);
    const { environment: production } = await seedDeployedEnvironment();
    for (const type of ["PRODUCTION", "STAGING"] as const) {
      const environment = await database.prisma.runtimeEnvironment.update({
        where: { id: production.id },
        data: { type },
      });
      for (const branch of [undefined, "feature", "refs/heads/feature", "refs/invalid"]) {
        const response = await call(environment, branch);
        expect(response.status).toBe(200);
        expect(await response.text()).toBe(environment.id);
      }
    }
  });

  it("keeps run tokens independent of root rotation and enforces the 30-day child limit", async () => {
    const { environment } = await seedDeployedEnvironment();
    const token = await tokenFor(environment);
    const rotatedKey = `${environment.apiKey}_rotated`;
    await database.prisma.runtimeEnvironment.update({
      where: { id: environment.id },
      data: { apiKey: rotatedKey },
    });
    expect((await v1.loader(args("GET", "rotation/output.json", token))).status).toBe(200);
    const { handlePublicTokenRequest } = await import("~/services/publicTokens.server");
    const mint = (expirationTime: string) =>
      handlePublicTokenRequest(
        new Request("https://api.example.com/public-tokens", {
          method: "POST",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify({ scopes: ["read:runs"], expirationTime }),
        })
      );
    const response = await mint("30d");
    expect(response.status).toBe(200);
    const child = (await response.json()).token;
    expect((await validateJWT(child, rotatedKey)).ok).toBe(true);
    expect(decodeJwt(child).exp).toBeGreaterThan(decodeJwt(token).exp!);
    expect((await mint("31d")).status).toBe(400);
  });

  // Catches: opt-in legacy routes rejecting run tokens or bypassing their resource scopes.
  it("authorizes run results and rescheduling within the token environment", async () => {
    const seed = await seedDeployedEnvironment();
    const other = await seedDeployedEnvironment();
    const seeded = await seedTestRun(database.prisma, {
      environmentId: seed.environment.id,
      projectId: seed.project.id,
      withBatch: true,
    });
    await database.prisma.taskRun.update({
      where: { id: seeded.run.id },
      data: {
        engine: "V2",
        status: "COMPLETED_SUCCESSFULLY",
        output: '{"ok":true}',
        outputType: "application/json",
      },
    });
    const results = await import("~/routes/api.v1.runs.$runParam.result");
    const batches = await import("~/routes/api.v1.batches.$batchParam.results");
    const reschedule = await import("~/routes/api.v1.runs.$runParam.reschedule");
    const request = (bearer: string, body?: object) =>
      new Request("https://api.example.com/test", {
        method: body ? "POST" : "GET",
        headers: { Authorization: `Bearer ${bearer}`, "Content-Type": "application/json" },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    const admin = await tokenFor(seed.environment);
    const readOnly = await tokenFor(seed.environment, [`read:runs:${seeded.runFriendlyId}`]);
    const otherToken = await tokenFor(other.environment);
    for (const [bearer, expected] of [
      [admin, 200],
      [readOnly, 200],
      [otherToken, 404],
    ] as const) {
      expect(
        (
          await results.loader({
            request: request(bearer),
            params: { runParam: seeded.runFriendlyId },
            context: {},
          })
        ).status
      ).toBe(expected);
    }
    expect(
      (
        await batches.loader({
          request: request(admin),
          params: { batchParam: seeded.batchFriendlyId },
          context: {},
        })
      ).status
    ).toBe(200);
    expect(
      (
        await batches.loader({
          request: request(otherToken),
          params: { batchParam: seeded.batchFriendlyId },
          context: {},
        })
      ).status
    ).toBe(404);
    expect(
      (
        await reschedule.action({
          request: request(readOnly, { delay: "1h" }),
          params: { runParam: seeded.runFriendlyId },
          context: {},
        })
      ).status
    ).toBe(403);
    const notDelayed = await reschedule.action({
      request: request(admin, { delay: "1h" }),
      params: { runParam: seeded.runFriendlyId },
      context: {},
    });
    expect(notDelayed.status).toBe(400);
    expect(await notDelayed.json()).toMatchObject({
      error: "Cannot reschedule a run that is not delayed",
    });
    expect(
      (
        await reschedule.action({
          request: request(otherToken, { delay: "1h" }),
          params: { runParam: seeded.runFriendlyId },
          context: {},
        })
      ).status
    ).toBe(404);
  });

  // Catches: signed run tokens reading sibling environments or mutating shared schedules.
  it("confines schedule reads and mutations to the token environment", async () => {
    const { scheduleEngine } = await import("~/v3/scheduleEngine.server");
    try {
      await assertRunTokenSchedules(database, tokenFor);
    } finally {
      await scheduleEngine.quit();
    }
  });

  // Catches: run-token env-var writes escaping into another environment or branch parent.
  it("allows same-environment env vars but denies parent writes before any changes", async () => {
    const seed = await seedDeployedEnvironment();
    const create = await import("~/routes/api.v1.projects.$projectRef.envvars.$slug");
    const item = await import("~/routes/api.v1.projects.$projectRef.envvars.$slug.$name");
    const upload = await import("~/routes/api.v1.projects.$projectRef.envvars.$slug.import");
    const bearer = await tokenFor(seed.environment);
    const request = (token: string, method: string, body?: object) =>
      new Request("https://api.example.com/envvars", {
        method,
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    const params = { projectRef: seed.project.externalRef, slug: "prod" };
    expect(
      (
        await create.action({
          request: request(bearer, "POST", { name: "RUN_TOKEN_TEST", value: "value" }),
          params,
          context: {},
        })
      ).status
    ).toBe(200);
    const read = await item.loader({
      request: request(bearer, "GET"),
      params: { ...params, name: "RUN_TOKEN_TEST" },
      context: {},
    });
    expect(read.status).toBe(200);
    expect(await read.json()).toMatchObject({ name: "RUN_TOKEN_TEST", value: "value" });
    expect(
      (
        await create.action({
          request: request(await tokenFor(seed.environment, ["read:envvars"]), "POST", {
            name: "DENIED",
            value: "value",
          }),
          params,
          context: {},
        })
      ).status
    ).toBe(403);
    await expect(
      create.loader({
        request: request(bearer, "GET"),
        params: { ...params, slug: "stg" },
        context: {},
      })
    ).rejects.toMatchObject({ status: 403 });
    const rejected = await upload.action({
      request: request(bearer, "POST", {
        variables: { MUST_NOT_WRITE: "value" },
        parentVariables: { ALSO_DENIED: "value" },
      }),
      params,
      context: {},
    });
    expect(rejected.status).toBe(403);
    expect(
      await database.prisma.environmentVariable.count({
        where: {
          projectId: seed.project.id,
          key: { in: ["MUST_NOT_WRITE", "ALSO_DENIED", "DENIED"] },
        },
      })
    ).toBe(0);
    expect(
      (
        await upload.action({
          request: request(bearer, "POST", { variables: { IMPORTED: "value" } }),
          params,
          context: {},
        })
      ).status
    ).toBe(200);
    expect(
      (
        await item.action({
          request: request(bearer, "PUT", { value: "updated" }),
          params: { ...params, name: "RUN_TOKEN_TEST" },
          context: {},
        })
      ).status
    ).toBe(200);
    expect(
      (
        await item.action({
          request: request(bearer, "DELETE"),
          params: { ...params, name: "RUN_TOKEN_TEST" },
          context: {},
        })
      ).status
    ).toBe(200);
  });

  it("records only bounded SDK labels using actual auth classification and deduplicates wrappers", async () => {
    const { environment } = await seedDeployedEnvironment();
    const { authenticateBearerWithTelemetry, observeLegacyBearerAuthentication } =
      await import("~/services/authTelemetry.server");
    const { authenticateApiRequestWithFailure, authenticateRequest } =
      await import("~/services/apiAuth.server");
    const request = (bearer: string, operation: string, reason: string) =>
      new Request("https://api.example.com/test", {
        headers: {
          Authorization: `Bearer ${bearer}`,
          "x-trigger-sdk-operation": operation,
          "x-trigger-sdk-credential-reason": reason,
          "x-trigger-sdk-version": "unbounded-user-input",
        },
      });
    const token = await tokenFor(environment);
    const runRequest = request(token, "triggerTask", "selected");
    await observeLegacyBearerAuthentication(runRequest, () =>
      authenticateBearerWithTelemetry(runRequest, {})
    );
    await authenticateBearerWithTelemetry(runRequest, {});
    await authenticateApiRequestWithFailure(
      request(environment.apiKey, "getRunResult", "unsupported_operation")
    );
    await authenticateBearerWithTelemetry(
      request(environment.apiKey, "executeQueryProjectOrOrganization", "branch_override"),
      {}
    );
    await authenticateRequest(request(environment.apiKey, "listProjectRuns", "missing_token"));
    await authenticateBearerWithTelemetry(
      request(environment.apiKey, "run_secret-id", "selected"),
      {}
    );
    await authenticateBearerWithTelemetry(
      request(environment.apiKey, "triggerTask", "unknown-secret-reason"),
      {}
    );
    await authenticateBearerWithTelemetry(request(environment.apiKey, "triggerTask", ""), {});
    // Cumulative exports repeat every point; a periodic export during the test adds a batch.
    const exported = (await telemetryMetrics.getMetrics()).slice(-1);
    const points = exported
      .flatMap((resource) => resource.scopeMetrics)
      .flatMap((scope) => scope.metrics)
      .filter((metric) => metric.descriptor.name === "api_auth.sdk_credential_selections")
      .flatMap((metric) => metric.dataPoints);
    expect(points).toHaveLength(4);
    expect(points.map((point) => ({ attributes: point.attributes, value: point.value }))).toEqual(
      expect.arrayContaining([
        {
          attributes: {
            operation: "triggerTask",
            reason: "selected",
            credential_kind: "run_token",
          },
          value: 1,
        },
        {
          attributes: {
            operation: "getRunResult",
            reason: "unsupported_operation",
            credential_kind: "root_api_key",
          },
          value: 1,
        },
        {
          attributes: {
            operation: "executeQueryProjectOrOrganization",
            reason: "branch_override",
            credential_kind: "root_api_key",
          },
          value: 1,
        },
        {
          attributes: {
            operation: "listProjectRuns",
            reason: "missing_token",
            credential_kind: "root_api_key",
          },
          value: 1,
        },
      ])
    );
  });

  // Catches: legacy auth losing default attribution or nested auth wrappers double-counting it.
  it("attributes default selections from bearer and legacy authentication once per request", async () => {
    const { environment } = await seedDeployedEnvironment();
    const { authenticateBearerWithTelemetry, observeLegacyBearerAuthentication } =
      await import("~/services/authTelemetry.server");
    const { authenticateApiRequestWithFailure } = await import("~/services/apiAuth.server");
    const { configureSdkDefaultAttribution } =
      await import("~/services/sdkDefaultAttribution.server");
    configureSdkDefaultAttribution({
      test: { id: "routes/test.$id", path: "test/:id", module: {} },
    });
    const request = () =>
      new Request("https://api.example.com/test/private-id?secret=private", {
        headers: {
          Authorization: `Bearer ${environment.apiKey}`,
          "x-trigger-sdk-operation": "default",
          "x-trigger-sdk-credential-reason": "unsupported_operation",
          "trigger-version": "4.8.5",
        },
      });
    try {
      const bearerRequest = request();
      await observeLegacyBearerAuthentication(bearerRequest, () =>
        authenticateBearerWithTelemetry(bearerRequest, {})
      );
      await authenticateApiRequestWithFailure(request());
      const points = (await telemetryMetrics.getMetrics())
        .slice(-1)
        .flatMap((resource) => resource.scopeMetrics)
        .flatMap((scope) => scope.metrics)
        .filter((metric) => metric.descriptor.name === "api_auth.sdk_default_destinations")
        .flatMap((metric) => metric.dataPoints);
      expect(points.map((point) => ({ attributes: point.attributes, value: point.value }))).toEqual(
        [
          {
            attributes: {
              http_method: "GET",
              route: "routes/test.$id",
              reason: "unsupported_operation",
              credential_kind: "root_api_key",
            },
            value: 2,
          },
        ]
      );
    } finally {
      configureSdkDefaultAttribution({});
    }
  });

  it("round-trips an offloaded packet with an admin run token", async () => {
    const { environment } = await seedDeployedEnvironment();
    const token = await tokenFor(environment);
    const uploaded = await v2.action(args("PUT", "run_packet_test/output.json", token));
    expect(uploaded.status).toBe(200);
    const upload = await uploaded.json();
    // A run token's upload lands in its own namespace, which is the only place its triggers may point.
    expect(upload.storagePath).toBe("s3://uploads/run/run_packet_test/run_packet_test/output.json");
    expect((await fetch(upload.presignedUrl, { method: "PUT", body: '{"ok":true}' })).status).toBe(
      200
    );

    const downloaded = await v1.loader(args("GET", upload.storagePath, token));
    expect(downloaded.status).toBe(200);
    const download = await downloaded.json();
    expect(await (await fetch(download.presignedUrl)).text()).toBe('{"ok":true}');
  });

  it("requires packet capabilities rather than treating every run token as unrestricted", async () => {
    const { environment } = await seedDeployedEnvironment();
    const readOnly = await tokenFor(environment, ["read:packets"]);
    const runOnly = await tokenFor(environment, ["read:runs:run_packet_test"]);
    expect((await v1.loader(args("GET", "run_packet_test/output.json", readOnly))).status).toBe(
      200
    );
    expect((await v2.action(args("PUT", "run_packet_test/output.json", readOnly))).status).toBe(
      403
    );
    expect((await v1.loader(args("GET", "run_packet_test/output.json", runOnly))).status).toBe(403);
  });

  it("keeps packet keys inside the authenticated environment and rejects traversal", async () => {
    const first = await seedDeployedEnvironment();
    const second = await seedDeployedEnvironment();
    const firstToken = await tokenFor(first.environment);
    const secondToken = await tokenFor(second.environment);
    const filename = "run_packet_test/tenant.json";
    const upload = await (await v2.action(args("PUT", filename, firstToken))).json();
    await fetch(upload.presignedUrl, { method: "PUT", body: "first environment only" });
    const download = await (await v1.loader(args("GET", upload.storagePath, secondToken))).json();
    expect((await fetch(download.presignedUrl)).status).toBe(404);
    expect((await v1.loader(args("GET", "s3://../foreign.json", secondToken))).status).toBe(400);
    expect((await v2.action(args("PUT", "../foreign.json", secondToken))).status).toBe(400);
  });

  it("rejects scoped raw access when dev environments share a project and slug", async () => {
    const first = await seedTestEnvironment(database.prisma);
    const second = await database.prisma.runtimeEnvironment.create({
      data: {
        organizationId: first.organization.id,
        projectId: first.project.id,
        type: "DEVELOPMENT",
        slug: first.environment.slug,
        shortcode: "other-dev",
        apiKey: `${first.environment.apiKey}_other`,
        pkApiKey: `${first.environment.pkApiKey}_other`,
      },
    });
    for (const environment of [first.environment, second]) {
      const token = await tokenFor(environment);
      expect((await v1.loader(args("GET", "shared/payload.json", token))).status).toBe(403);
      expect((await v1.action(args("PUT", "shared/payload.json", token))).status).toBe(403);
      expect((await v2.action(args("PUT", "shared/payload.json", token))).status).toBe(403);
    }
    const legacy = await v2.action(args("PUT", "shared/payload.json", first.environment.apiKey));
    expect(legacy.status).toBe(200);
    expect((await legacy.json()).storagePath).toBe("s3://shared/payload.json");
  });

  it("keeps a run-scoped stream initializer's S2 grant limited to the authorized stream", async () => {
    const { environment, project } = await seedDeployedEnvironment();
    const { run } = await seedTestRun(database.prisma, {
      environmentId: environment.id,
      projectId: project.id,
    });
    await database.prisma.taskRun.update({
      where: { id: run.id },
      data: { realtimeStreamsVersion: "v2", streamBasinName: "run-token-test" },
    });
    const token = await tokenFor(environment, [`write:runs:${run.friendlyId}`]);
    const { S2RealtimeStreams } = await import("~/services/realtime/s2realtimeStreams.server");
    const scopedInitialization = vi.spyOn(S2RealtimeStreams.prototype, "initializeScopedStream");
    const unscopedInitialization = vi.spyOn(S2RealtimeStreams.prototype, "initializeStream");
    const { action } = await import("~/routes/realtime.v1.streams.$runId.$target.$streamId");
    const response = await action({
      request: new Request("https://api.example.com/realtime/v1/streams/test/self/progress", {
        method: "PUT",
        headers: { Authorization: `Bearer ${token}` },
      }),
      params: { runId: run.friendlyId, target: "self", streamId: "progress" },
      context: {},
    });
    expect(response.status).toBe(202);
    const streamName = `org/${environment.organizationId}/env/prod/${environment.id}/runs/${run.friendlyId}/progress`;
    expect(response.headers.get("x-s2-stream-name")).toBe(streamName);
    expect(scopedInitialization).toHaveBeenCalledWith(run.friendlyId, "progress");
    expect(unscopedInitialization).not.toHaveBeenCalled();
    scopedInitialization.mockRestore();
    unscopedInitialization.mockRestore();
  });

  // Catches: packet-only keys losing offloaded wait results, or run grants leaking other waitpoints.
  it("serves offloaded output only for waitpoints the run resumed from", async () => {
    const { environment, project, organization } = await seedDeployedEnvironment();
    const { run } = await seedTestRun(database.prisma, {
      environmentId: environment.id,
      projectId: project.id,
    });
    const waitpointFor = (key: string) =>
      database.prisma.waitpoint.create({
        data: {
          friendlyId: `waitpoint_${key}`,
          type: "MANUAL",
          status: "COMPLETED",
          completedAt: new Date(),
          idempotencyKey: key,
          userProvidedIdempotencyKey: false,
          output: `waitpoint_${key}/stream/record.json`,
          outputType: "application/store",
          environmentId: environment.id,
          projectId: project.id,
        },
      });
    const resumed = await waitpointFor("resumed");
    const other = await waitpointFor("other");
    await database.prisma.taskRunExecutionSnapshot.create({
      data: {
        engine: "V2",
        executionStatus: "EXECUTING",
        description: "Resumed",
        runId: run.id,
        runStatus: "EXECUTING",
        environmentId: environment.id,
        environmentType: "PRODUCTION",
        projectId: project.id,
        organizationId: organization.id,
        completedWaitpoints: { connect: { id: resumed.id } },
      },
    });
    const token = await tokenFor(environment, [`read:runs:${run.friendlyId}`]);
    const { loader } = await import("~/routes/api.v1.runs.$runId.waitpoints.$waitpointId.output");
    for (const bearer of [token, await packetReaderFor(environment.id)]) {
      const load = (waitpointId: string) =>
        loader({
          request: new Request("https://api.example.com/test", {
            headers: { Authorization: `Bearer ${bearer}` },
          }),
          params: { runId: run.friendlyId, waitpointId },
          context: {},
        });

      const response = await load(resumed.friendlyId);
      expect(response.status).toBe(200);
      expect((await response.json()).presignedUrl).toContain(
        "waitpoint_resumed/stream/record.json"
      );
      expect((await load(other.friendlyId)).status).toBe(404);
    }
  });

  // Catches: packet-only keys losing run packets, or bypassing shared development namespace isolation.
  it.each(["PRODUCTION", "DEVELOPMENT"] as const)(
    "preserves run packet access and namespace isolation in %s",
    async (environmentType) => {
      const { environment, project } =
        environmentType === "PRODUCTION"
          ? await seedDeployedEnvironment()
          : await seedTestEnvironment(database.prisma);
      const { run } = await seedTestRun(database.prisma, {
        environmentId: environment.id,
        projectId: project.id,
      });
      await database.prisma.taskRun.update({
        where: { id: run.id },
        data: {
          payload: "stored/payload.json",
          payloadType: "application/store",
          output: "stored/output.json",
          outputType: "application/store",
        },
      });
      const key = await packetReaderFor(environment.id);
      const runToken = await tokenFor(environment, [`read:runs:${run.friendlyId}`, "read:packets"]);
      const foreign = await seedDeployedEnvironment();
      const foreignKey = await packetReaderFor(foreign.environment.id);
      const { loader } = await import("~/routes/api.v1.runs.$runId.packets.$field");
      const load = (field: "payload" | "output", bearer: string) =>
        loader({
          request: new Request("https://api.example.com/test", {
            headers: { Authorization: `Bearer ${bearer}` },
          }),
          params: { runId: run.friendlyId, field },
          context: {},
        });

      for (const field of ["payload", "output"] as const) {
        const response = await load(field, key);
        expect(response.status).toBe(environmentType === "PRODUCTION" ? 200 : 403);
        if (response.status === 200) {
          expect((await response.json()).presignedUrl).toContain(`stored/${field}.json`);
        }
        expect((await load(field, runToken)).status).toBe(200);
        expect((await load(field, foreignKey)).status).toBe(404);
      }
    }
  );

  // Catches: session output setup ignoring direction-scoped session grants, or a `.out` grant opening `.in`.
  it("lets a direction-scoped run token initialize only that session direction", async () => {
    const { environment } = await seedDeployedEnvironment();
    const session = await seedTestApiSession(database.prisma, environment);
    const token = await tokenFor(environment, [`write:sessions:${session.friendlyId}:out`]);
    const { action } = await import("~/routes/realtime.v1.sessions.$session.$io");
    const initialize = (io: "in" | "out") =>
      action({
        request: new Request(`https://api.example.com/realtime/v1/sessions/x/${io}`, {
          method: "PUT",
          headers: { Authorization: `Bearer ${token}` },
        }),
        params: { session: session.friendlyId, io },
        context: {},
      });

    // Past authorization: the test environment has no S2 backend, so it reports 501.
    expect((await initialize("out")).status).not.toBe(403);
    expect((await initialize("in")).status).toBe(403);
  });

  it("mints a valid delegated public JWT through real run-token verification", async () => {
    const { environment } = await seedDeployedEnvironment();
    const token = await tokenFor(environment);
    const { handlePublicTokenRequest } = await import("~/services/publicTokens.server");
    const response = await handlePublicTokenRequest(
      new Request("https://api.example.com/api/v1/auth/public-tokens", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ scopes: ["read:runs:run_packet_test"], expirationTime: "2h" }),
      })
    );
    expect(response.status).toBe(200);
    const delegated = (await response.json()).token;
    const validation = await validateJWT(delegated, environment.apiKey);
    expect(validation.ok).toBe(true);
    expect(decodeJwt(delegated)).toMatchObject({
      sub: environment.id,
      scopes: ["read:runs:run_packet_test"],
      pub: true,
    });
    expect(decodeJwt(delegated).exp).toBeGreaterThan(decodeJwt(token).exp!);
  });

  it("does not let a restricted run token delegate permissions it lacks", async () => {
    const { environment } = await seedDeployedEnvironment();
    const token = await tokenFor(environment, ["read:runs:run_packet_test"]);
    const { handlePublicTokenRequest } = await import("~/services/publicTokens.server");
    const response = await handlePublicTokenRequest(
      new Request("https://api.example.com/api/v1/auth/public-tokens", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ scopes: ["write:runs:run_other"] }),
      })
    );
    expect(response.status).toBe(403);
    expect((await response.json()).code).toBe("scopes_exceed_key_access");
  });

  it("preserves root-key uploads and the legacy v1 response shape", async () => {
    const { environment } = await seedDeployedEnvironment();
    const legacy = await v1.action(args("PUT", "legacy/payload.json", environment.apiKey));
    expect(legacy.status).toBe(200);
    const body = await legacy.json();
    expect(body.presignedUrl).toBeTypeOf("string");
    expect(body.storagePath).toBeUndefined();
    const current = await v2.action(args("PUT", "current/payload.json", environment.apiKey));
    expect(current.status).toBe(200);
    expect((await current.json()).storagePath).toBe("s3://current/payload.json");
  });
});
