import { once } from "node:events";
import { createServer, type Server } from "node:http";
import { STSClient, GetCallerIdentityCommand } from "@aws-sdk/client-sts";
import {
  ApiError,
  OIDCTokenError,
  apiClientManager,
  sdkScope,
  taskContext,
  type TaskRunContext,
} from "@trigger.dev/core/v3";
import { unregisterGlobal } from "../../../../core/dist/esm/v3/utils/globals.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { auth } from "../auth.js";
import { awsCredentialProvider } from "./aws.js";

const envNames = [
  "TRIGGER_RUN_TOKEN",
  "TRIGGER_SECRET_KEY",
  "TRIGGER_ACCESS_TOKEN",
  "TRIGGER_API_URL",
  "AWS_ENDPOINT_URL_STS",
] as const;
const originalEnv = Object.fromEntries(envNames.map((name) => [name, process.env[name]]));
const originalContext = taskContext.ctx;
const originalWorker = taskContext.worker;

function runToken(exp = Math.floor(Date.now() / 1000) + 3600, runId = "run_first") {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "RS256", typ: "run+jwt" })}.${encode({ token_use: "run", aud: "trigger:api", exp, scopes: ["admin"], run_id: runId })}.signature`;
}

function enterRun(type: TaskRunContext["environment"]["type"] = "PRODUCTION", runId = "run_first") {
  taskContext.setGlobalTaskContext({
    ctx: {
      task: { id: "oidc-test", filePath: "oidc.test.ts" },
      attempt: { number: 1, startedAt: new Date() },
      run: {
        id: runId,
        tags: [],
        isTest: false,
        isReplay: false,
        createdAt: new Date(),
        startedAt: new Date(),
      },
      machine: { name: "micro", cpu: 1, memory: 0.5, centsPerMs: 0 },
      queue: { id: "queue_test", name: "oidc-test" },
      environment: { id: "env_test", slug: "prod", type },
      organization: { id: "org_test", slug: "test", name: "Test" },
      project: { id: "project_test", ref: "proj_test", slug: "test", name: "Test" },
    },
    worker: { id: "worker_test", version: "1", contentHash: "test", engine: "V2" },
  });
}

type MintRequest = { authorization?: string; method?: string; path?: string; body: unknown };

// Catches: root-key fallback, stale run credentials after refresh, and unusable STS expiration/caching.
describe("run-only OIDC and AWS credentials over HTTP", () => {
  let servers: Server[];
  let mintRequests: MintRequest[];
  let stsRequests: URLSearchParams[];
  let mintStatus: number;
  let mintHeaders: Record<string, string>;
  let mintExpiresAt: Date;
  let stsComplete: boolean;
  let expiration: Date;

  async function listen(server: Server) {
    servers.push(server);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing server address");
    return `http://127.0.0.1:${address.port}`;
  }

  beforeEach(async () => {
    servers = [];
    mintRequests = [];
    stsRequests = [];
    mintStatus = 200;
    mintHeaders = {};
    mintExpiresAt = new Date(Date.now() + 300_000);
    stsComplete = true;
    expiration = new Date(Date.now() + 3600 * 1000);
    apiClientManager.disable();
    enterRun();
    process.env.TRIGGER_RUN_TOKEN = runToken();
    process.env.TRIGGER_SECRET_KEY = "tr_prod_root_must_never_be_sent";
    process.env.TRIGGER_ACCESS_TOKEN = "tr_prod_alternate_must_never_be_sent";
    process.env.TRIGGER_API_URL = await listen(
      createServer(async (request, response) => {
        let body = "";
        for await (const chunk of request) body += chunk;
        mintRequests.push({
          authorization: request.headers.authorization,
          method: request.method,
          path: request.url,
          body: JSON.parse(body),
        });
        response.writeHead(mintStatus, { "Content-Type": "application/json", ...mintHeaders });
        response.end(
          JSON.stringify(
            mintStatus === 200
              ? {
                  token: `external-${mintRequests.length}`,
                  expiresAt: mintExpiresAt.toISOString(),
                }
              : { error: "OIDC access denied", code: "OIDC_DENIED" }
          )
        );
      })
    );
    process.env.AWS_ENDPOINT_URL_STS = await listen(
      createServer(async (request, response) => {
        let body = "";
        for await (const chunk of request) body += chunk;
        const params = new URLSearchParams(body);
        stsRequests.push(params);
        response.writeHead(200, { "Content-Type": "text/xml" });
        response.end(
          params.get("Action") === "GetCallerIdentity"
            ? `<GetCallerIdentityResponse xmlns="https://sts.amazonaws.com/doc/2011-06-15/"><GetCallerIdentityResult><Account>123456789012</Account></GetCallerIdentityResult></GetCallerIdentityResponse>`
            : `<AssumeRoleWithWebIdentityResponse xmlns="https://sts.amazonaws.com/doc/2011-06-15/"><AssumeRoleWithWebIdentityResult><Credentials><AccessKeyId>key-${mintRequests.length}</AccessKeyId><SecretAccessKey>secret</SecretAccessKey><SessionToken>session</SessionToken>${stsComplete ? `<Expiration>${expiration.toISOString()}</Expiration>` : ""}</Credentials></AssumeRoleWithWebIdentityResult></AssumeRoleWithWebIdentityResponse>`
        );
      })
    );
  });

  afterEach(async () => {
    apiClientManager.disable();
    if (originalContext && originalWorker) {
      taskContext.setGlobalTaskContext({ ctx: originalContext, worker: originalWorker });
    } else {
      unregisterGlobal("task-context");
    }
    for (const name of envNames) {
      if (originalEnv[name] === undefined) delete process.env[name];
      else process.env[name] = originalEnv[name];
    }
    await Promise.all(
      servers.map(
        (server) =>
          new Promise<void>((resolve, reject) => {
            server.close((error) => (error ? reject(error) : resolve()));
            server.closeAllConnections();
          })
      )
    );
  });

  it("mints directly with the current process token on every invocation", async () => {
    const first = process.env.TRIGGER_RUN_TOKEN;
    expect(await auth.getOIDCToken({ audience: "service-one" })).toEqual({
      token: "external-1",
      expiresAt: mintExpiresAt,
    });
    process.env.TRIGGER_RUN_TOKEN = runToken(undefined, "run_next");
    expect(await auth.getOIDCToken({ audience: "service-two" })).toEqual({
      token: "external-2",
      expiresAt: mintExpiresAt,
    });
    expect(mintRequests).toEqual([
      {
        method: "POST",
        path: "/api/v1/auth/oidc/token",
        authorization: `Bearer ${first}`,
        body: { audience: "service-one" },
      },
      {
        method: "POST",
        path: "/api/v1/auth/oidc/token",
        authorization: `Bearer ${process.env.TRIGGER_RUN_TOKEN}`,
        body: { audience: "service-two" },
      },
    ]);
  });

  it.each([
    [undefined, "OIDC_RUN_TOKEN_MISSING"],
    [runToken(1), "OIDC_RUN_TOKEN_EXPIRED"],
    ["not-a-run-token", "OIDC_RUN_TOKEN_INVALID"],
  ])("rejects unavailable run credentials without sending API keys", async (token, code) => {
    if (token === undefined) delete process.env.TRIGGER_RUN_TOKEN;
    else process.env.TRIGGER_RUN_TOKEN = token;
    await expect(auth.getOIDCToken({ audience: "service" })).rejects.toMatchObject({ code });
    expect(mintRequests).toHaveLength(0);
  });

  it("rejects development and isolated/outside task scopes", async () => {
    enterRun("DEVELOPMENT");
    await expect(auth.getOIDCToken({ audience: "service" })).rejects.toMatchObject({
      code: "OIDC_NOT_IN_DEPLOYED_RUN",
    });
    enterRun();
    await expect(
      sdkScope.withScope({ apiClientConfig: {}, inheritContext: false }, () =>
        auth.getOIDCToken({ audience: "service" })
      )
    ).rejects.toMatchObject({ code: "OIDC_NOT_IN_DEPLOYED_RUN" });
    expect(mintRequests).toHaveLength(0);
  });

  it.each(["accessToken", "secretKey"] as const)(
    "ignores configured global and scoped %s credentials without falling back to them",
    async (field) => {
      const configured = {
        [field]: "another-project-root-key",
        refreshAccessToken: async () => {
          throw new Error("OIDC must not refresh configured credentials");
        },
      };
      auth.configure(configured);
      expect((await auth.getOIDCToken({ audience: "service" })).token).toBe("external-1");
      expect(
        (await auth.withAuth(configured, () => auth.getOIDCToken({ audience: "service" }))).token
      ).toBe("external-2");
      expect(mintRequests.map((request) => request.authorization)).toEqual([
        `Bearer ${process.env.TRIGGER_RUN_TOKEN}`,
        `Bearer ${process.env.TRIGGER_RUN_TOKEN}`,
      ]);
      delete process.env.TRIGGER_RUN_TOKEN;
      await expect(auth.getOIDCToken({ audience: "service" })).rejects.toMatchObject({
        code: "OIDC_RUN_TOKEN_MISSING",
      });
      expect(mintRequests).toHaveLength(2);
    }
  );

  it.each([401, 403, 429])(
    "preserves API error details without a root-key retry (%s)",
    async (status) => {
      mintStatus = status;
      mintHeaders = { "x-oidc-test": "preserved" };
      auth.configure({ requestOptions: { retry: { maxAttempts: 1 } } });
      const error = await auth.getOIDCToken({ audience: "service" }).catch((error) => error);
      expect(error).toBeInstanceOf(OIDCTokenError);
      expect(error).toBeInstanceOf(ApiError);
      expect(error).toMatchObject({
        status,
        code: "OIDC_DENIED",
        message: "OIDC access denied",
        headers: { "x-oidc-test": "preserved" },
        body: { error: "OIDC access denied", code: "OIDC_DENIED" },
      });
      expect(error.cause).toBeInstanceOf(ApiError);
      expect(error.cause).not.toBeInstanceOf(OIDCTokenError);
      expect(mintRequests).toHaveLength(1);
      expect(mintRequests[0]?.authorization).toBe(`Bearer ${process.env.TRIGGER_RUN_TOKEN}`);
    }
  );

  // Catches: retrying permanently unavailable OIDC, or disabling retries for transient outages.
  it.each([
    { shouldRetry: "false", requests: 1 },
    { shouldRetry: undefined, requests: 2 },
  ])(
    "honors permanent-unavailability retry guidance ($shouldRetry)",
    async ({ shouldRetry, requests }) => {
      mintStatus = 503;
      if (shouldRetry) mintHeaders["x-should-retry"] = shouldRetry;
      auth.configure({
        requestOptions: {
          retry: { maxAttempts: 2, minTimeoutInMs: 1, maxTimeoutInMs: 1, randomize: false },
        },
      });
      await expect(auth.getOIDCToken({ audience: "service" })).rejects.toBeInstanceOf(
        OIDCTokenError
      );
      expect(mintRequests).toHaveLength(requests);
    }
  );

  it("returns refreshable credentials with fresh OIDC and STS calls, and supports session options", async () => {
    const provider = awsCredentialProvider({
      roleArn: "arn:aws:iam::123456789012:role/test",
      region: "us-east-1",
    });
    expect(await provider()).toEqual({
      accessKeyId: "key-1",
      secretAccessKey: "secret",
      sessionToken: "session",
      expiration,
    });
    process.env.TRIGGER_RUN_TOKEN = runToken(undefined, "run_next");
    enterRun("PRODUCTION", "run_next");
    expect((await provider()).accessKeyId).toBe("key-2");
    expect(stsRequests.map((request) => request.get("WebIdentityToken"))).toEqual([
      "external-1",
      "external-2",
    ]);
    expect(stsRequests[0]?.get("DurationSeconds")).toBe("3600");
    expect(stsRequests.map((request) => request.get("RoleSessionName"))).toEqual([
      "run_first",
      "run_next",
    ]);
    expect(mintRequests[1]?.authorization).toBe(`Bearer ${process.env.TRIGGER_RUN_TOKEN}`);
    expect(
      mintRequests.every(
        (request) => (request.body as { audience: string }).audience === "sts.amazonaws.com"
      )
    ).toBe(true);
    await awsCredentialProvider({
      roleArn: "arn:aws:iam::123456789012:role/test",
      region: "us-east-1",
      roleSessionName: "custom-session",
      durationSeconds: 900,
    })();
    expect(stsRequests.at(-1)?.get("DurationSeconds")).toBe("900");
    expect(stsRequests.at(-1)?.get("RoleSessionName")).toBe("custom-session");
  });

  it("lets the AWS SDK cache and refresh returned credentials", async () => {
    const client = new STSClient({
      region: "us-east-1",
      credentials: awsCredentialProvider({
        roleArn: "arn:aws:iam::123456789012:role/test",
        region: "us-east-1",
      }),
    });
    try {
      await client.send(new GetCallerIdentityCommand({}));
      await client.send(new GetCallerIdentityCommand({}));
      expect(mintRequests).toHaveLength(1);
      expiration = new Date(Date.now() - 1000);
      await client.config.credentials({ forceRefresh: true });
      const beforeExpirationRefresh = mintRequests.length;
      expect(beforeExpirationRefresh).toBeGreaterThan(1);
      expiration = new Date(Date.now() + 3600 * 1000);
      process.env.TRIGGER_RUN_TOKEN = runToken(undefined, "run_after_restore");
      await client.send(new GetCallerIdentityCommand({}));
      expect(mintRequests.length).toBeGreaterThan(beforeExpirationRefresh);
      expect(mintRequests.at(-1)?.authorization).toBe(`Bearer ${process.env.TRIGGER_RUN_TOKEN}`);
      const afterExpirationRefresh = mintRequests.length;
      await client.send(new GetCallerIdentityCommand({}));
      expect(mintRequests).toHaveLength(afterExpirationRefresh);
    } finally {
      client.destroy();
    }
  });

  it("rejects incomplete STS credentials rather than returning a non-refreshable identity", async () => {
    stsComplete = false;
    await expect(
      awsCredentialProvider({
        roleArn: "arn:aws:iam::123456789012:role/test",
        region: "us-east-1",
      })()
    ).rejects.toThrow("AWS STS did not return complete temporary credentials");
  });
});
