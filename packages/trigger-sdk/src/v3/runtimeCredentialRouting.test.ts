import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { apiClientManager } from "@trigger.dev/core/v3";
import { runInMockTaskContext } from "@trigger.dev/core/v3/test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { auth } from "./auth.js";
import { query } from "./query.js";
import { TriggerClient } from "./triggerClient.js";

const ROOT = "tr_prod_compatibility";
const RUN = [
  { alg: "RS256", typ: "run+jwt" },
  {
    aud: "trigger:api",
    token_use: "run",
    scopes: ["admin"],
    exp: Math.floor(Date.now() / 1000) + 3600,
  },
]
  .map((part) => Buffer.from(JSON.stringify(part)).toString("base64url"))
  .concat("signature")
  .join(".");
const ENV_KEYS = [
  "TRIGGER_API_URL",
  "TRIGGER_SECRET_KEY",
  "TRIGGER_ACCESS_TOKEN",
  "TRIGGER_RUN_TOKEN",
  "TRIGGER_PREVIEW_BRANCH",
  "TRIGGER_DEV_BRANCH",
  "VERCEL_GIT_COMMIT_REF",
] as const;

describe("in-task request credential routing", () => {
  let previousEnv: Record<string, string | undefined>;
  let server: Server;
  let requests: { authorization?: string; branch?: string; body: unknown }[];
  let status: number;
  let telemetry: { operation?: string; reason?: string }[];
  let retryWithExpiredToken: boolean;

  beforeEach(async () => {
    previousEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
    for (const key of ENV_KEYS) delete process.env[key];
    apiClientManager.disable();
    requests = [];
    status = 200;
    telemetry = [];
    retryWithExpiredToken = false;
    server = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      telemetry.push({
        operation: req.headers["x-trigger-sdk-operation"] as string | undefined,
        reason: req.headers["x-trigger-sdk-credential-reason"] as string | undefined,
      });
      requests.push({
        authorization: req.headers.authorization,
        branch: req.headers["x-trigger-branch"] as string | undefined,
        body: chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined,
      });
      if (retryWithExpiredToken && requests.length === 1) {
        process.env.TRIGGER_RUN_TOKEN = RUN.replace(
          RUN.split(".")[1]!,
          Buffer.from(
            JSON.stringify({ aud: "trigger:api", token_use: "run", scopes: ["admin"], exp: 1 })
          ).toString("base64url")
        );
        res
          .writeHead(503, { "content-type": "application/json" })
          .end(JSON.stringify({ error: "Retry" }));
        return;
      }
      res.writeHead(status, { "content-type": "application/json" });
      res.end(
        JSON.stringify(status === 200 ? { format: "json", results: [] } : { error: "Denied" })
      );
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    process.env.TRIGGER_API_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    process.env.TRIGGER_SECRET_KEY = ROOT;
    process.env.TRIGGER_RUN_TOKEN = RUN;
  });

  afterEach(async () => {
    apiClientManager.disable();
    for (const key of ENV_KEYS) {
      if (previousEnv[key] === undefined) delete process.env[key];
      else process.env[key] = previousEnv[key];
    }
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("selects compatibility credentials before project/organization queries, retaining environment run tokens", async () =>
    runInMockTaskContext(async () => {
      for (const scope of [undefined, "environment", "project", "organization"] as const) {
        await query.execute("SELECT 1", { scope });
      }
      expect(requests.map((request) => request.authorization)).toEqual([
        `Bearer ${RUN}`,
        `Bearer ${RUN}`,
        `Bearer ${ROOT}`,
        `Bearer ${ROOT}`,
      ]);
      expect(telemetry).toEqual([
        { operation: "executeQuery", reason: "selected" },
        { operation: "executeQuery", reason: "selected" },
        { operation: "executeQueryProjectOrOrganization", reason: "unsupported_operation" },
        { operation: "executeQueryProjectOrOrganization", reason: "unsupported_operation" },
      ]);
      expect(requests.map((request) => request.body)).toEqual(
        ["environment", "environment", "project", "organization"].map((scope) => ({
          query: "SELECT 1",
          scope,
          format: "json",
        }))
      );
    }));

  it.each([401, 403])(
    "never escalates query auth failures (%s) to the compatibility key",
    async (code) =>
      runInMockTaskContext(async () => {
        status = code;
        await expect(query.execute("SELECT 1")).rejects.toMatchObject({ status: code });
        expect(requests.map((request) => request.authorization)).toEqual([`Bearer ${RUN}`]);
      })
  );

  it("distinguishes inherited/same preview branch from explicit cross-environment targets", async () =>
    runInMockTaskContext(
      async () => {
        process.env.TRIGGER_PREVIEW_BRANCH = "a";
        await query.execute("SELECT 1");
        await auth.withAuth({ previewBranch: "a" }, () => query.execute("SELECT 1"));
        await auth.withAuth({ previewBranch: "refs/heads/a" }, () => query.execute("SELECT 1"));
        await auth.withAuth({ previewBranch: "b" }, () => query.execute("SELECT 1"));
        await apiClientManager.clientOrThrow({ previewBranch: "b" }).executeQuery("SELECT 1");
        await apiClientManager.client!.executeQuery("SELECT 1");
        expect(telemetry.map((entry) => entry.reason)).toEqual([
          "selected",
          "selected",
          "selected",
          "branch_override",
          "branch_override",
          "selected",
        ]);
        expect(requests.map(({ authorization, branch }) => ({ authorization, branch }))).toEqual(
          [
            [RUN, "a"],
            [RUN, "a"],
            [RUN, "refs/heads/a"],
            [ROOT, "b"],
            [ROOT, "b"],
            [RUN, "a"],
          ].map(([key, branch]) => ({ authorization: `Bearer ${key}`, branch }))
        );
      },
      { ctx: { environment: { type: "PREVIEW" } } }
    ));

  it("preserves scoped-client branch targeting and explicit credential precedence", async () =>
    runInMockTaskContext(
      async () => {
        process.env.TRIGGER_PREVIEW_BRANCH = "a";
        const client = new TriggerClient({ previewBranch: "b", inheritContext: true });
        await client.auth.createPublicToken({ scopes: { read: { runs: true } } });
        await auth.withAuth({ previewBranch: "b", accessToken: "explicit" }, () =>
          query.execute("SELECT 1")
        );
        expect(requests.map(({ authorization, branch }) => ({ authorization, branch }))).toEqual([
          { authorization: `Bearer ${ROOT}`, branch: "b" },
          { authorization: "Bearer explicit", branch: "b" },
        ]);
      },
      { ctx: { environment: { type: "PREVIEW" } } }
    ));

  it.each(["STAGING", "PRODUCTION"] as const)(
    "retains run tokens for inherited and requested branches in %s",
    async (type) =>
      runInMockTaskContext(
        async () => {
          process.env.VERCEL_GIT_COMMIT_REF = "main";
          await query.execute("SELECT 1");
          await auth.withAuth({ previewBranch: "other" }, () => query.execute("SELECT 1"));
          await apiClientManager.clientOrThrow({ previewBranch: "other" }).executeQuery("SELECT 1");
          apiClientManager.setGlobalAPIClientConfiguration({ previewBranch: "other" });
          await apiClientManager.client!.executeQuery("SELECT 1");
          expect(requests.map((request) => request.authorization)).toEqual(
            Array(4).fill(`Bearer ${RUN}`)
          );
          expect(requests.map((request) => request.branch)).toEqual([
            "main",
            "other",
            "other",
            "other",
          ]);
          expect(telemetry.map((entry) => entry.reason)).toEqual(Array(4).fill("selected"));
        },
        { ctx: { environment: { type } } }
      )
  );

  it("uses preview context to reject branch overrides without a branch carrier", async () =>
    runInMockTaskContext(
      async () => {
        await apiClientManager.clientOrThrow({ previewBranch: "other" }).executeQuery("SELECT 1");
        expect(requests[0]?.authorization).toBe(`Bearer ${ROOT}`);
        expect(telemetry[0]?.reason).toBe("branch_override");
      },
      { ctx: { environment: { type: "PREVIEW" } } }
    ));

  it("omits rollout headers outside tasks and for explicit credentials", async () => {
    await query.execute("SELECT 1");
    await runInMockTaskContext(() =>
      auth.withAuth({ accessToken: ROOT }, () => query.execute("SELECT 1"))
    );
    expect(telemetry).toEqual([{}, {}]);
  });

  it("updates telemetry with the actual credential selected on an HTTP retry", async () =>
    runInMockTaskContext(async () => {
      retryWithExpiredToken = true;
      await query.execute(
        "SELECT 1",
        {},
        {
          retry: {
            maxAttempts: 2,
            minTimeoutInMs: 1,
            maxTimeoutInMs: 1,
            factor: 1,
            randomize: false,
          },
        }
      );
      expect(requests.map((request) => request.authorization)).toEqual([
        `Bearer ${RUN}`,
        `Bearer ${ROOT}`,
      ]);
      expect(telemetry).toEqual([
        { operation: "executeQuery", reason: "selected" },
        { operation: "executeQuery", reason: "expired_token" },
      ]);
    }));

  it("handles root/named dev branches and the default sentinel", async () =>
    runInMockTaskContext(async () => {
      process.env.TRIGGER_DEV_BRANCH = "default";
      await query.execute("SELECT 1");
      await auth.withAuth({ previewBranch: "default" }, () => query.execute("SELECT 1"));
      await auth.withAuth({ previewBranch: "feature" }, () => query.execute("SELECT 1"));
      process.env.TRIGGER_DEV_BRANCH = "feature";
      await query.execute("SELECT 1");
      await auth.withAuth({ previewBranch: "default" }, () => query.execute("SELECT 1"));
      expect(requests.map((request) => request.authorization)).toEqual(
        [RUN, RUN, ROOT, RUN, ROOT].map((key) => `Bearer ${key}`)
      );
      expect(requests.map((request) => request.branch)).toEqual([
        undefined,
        "default",
        "feature",
        "feature",
        "default",
      ]);
    }));
});
