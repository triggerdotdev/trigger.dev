import type { PrismaClient } from "@trigger.dev/database";
import plugin from "@trigger.dev/rbac";
import express, { type RequestHandler } from "express";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { expect } from "vitest";
import { createMcpBearerAuthenticator } from "~/mcp/auth/bearer.server";
import { createMcpProtectedResourceHandler } from "~/mcp/protectedResource.server";
import { mcpTools } from "~/mcp/registry.server";
import { createMcpRouter } from "~/mcp/server.server";
import { createRunsTools } from "~/mcp/tools/runs.server";
import {
  createRuntimeEnvironment,
  createTestOrgProjectWithMember,
  uniqueId,
} from "./environmentVariablesFixtures";

const ORIGIN = "https://mcp.test";
const PRM_PATH = "/.well-known/oauth-protected-resource";

export function normalize(value: unknown, known: Record<string, string> = {}): unknown {
  const literals = Object.entries(known).sort(([a], [b]) => b.length - a.length);
  const scrub = (text: string) => {
    let out = text;
    for (const [literal, placeholder] of literals) out = out.split(literal).join(placeholder);
    return out
      .replace(/boundary="[0-9a-f]{24}"/g, 'boundary="<BOUNDARY>"')
      .replace(/cursor: "[^"]+"/g, 'cursor: "<CURSOR>"')
      .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z/g, "<TIMESTAMP>")
      .replace(/\bc[a-z0-9]{24}\b/g, "<CUID>");
  };
  const walk = (node: unknown): unknown => {
    if (typeof node === "string") return scrub(node);
    if (Array.isArray(node)) return node.map(walk);
    if (node && typeof node === "object") {
      return Object.fromEntries(Object.entries(node).map(([k, v]) => [scrub(k), walk(v)]));
    }
    return node;
  };
  return walk(value);
}

export async function seed(prisma: PrismaClient) {
  const a = await createTestOrgProjectWithMember(prisma);
  const b = await createTestOrgProjectWithMember(prisma);
  await prisma.project.updateMany({
    where: { id: { in: [a.project.id, b.project.id] } },
    data: { version: "V3" },
  });
  const environment = await createRuntimeEnvironment(prisma, {
    projectId: a.project.id,
    organizationId: a.organization.id,
    type: "PRODUCTION",
    slug: "prod",
  });
  const worker = await prisma.backgroundWorker.create({
    data: {
      friendlyId: uniqueId("worker"),
      contentHash: "hash",
      sdkVersion: "4.0.0",
      cliVersion: "4.0.0",
      projectId: a.project.id,
      runtimeEnvironmentId: environment.id,
      version: "20250101.1",
      metadata: {},
    },
  });
  await prisma.backgroundWorkerTask.create({
    data: {
      friendlyId: uniqueId("task"),
      slug: "my-task",
      filePath: "src/trigger/my-task.ts",
      workerId: worker.id,
      projectId: a.project.id,
      runtimeEnvironmentId: environment.id,
      payloadSchema: { type: "object", properties: { email: { type: "string" } } },
    },
  });
  const run = await prisma.taskRun.create({
    data: {
      friendlyId: uniqueId("run"),
      taskIdentifier: "my-task",
      payload: JSON.stringify({ hello: "world" }),
      payloadType: "application/json",
      traceId: uniqueId("trace"),
      spanId: uniqueId("span"),
      queue: "task/my-task",
      runtimeEnvironmentId: environment.id,
      environmentType: "PRODUCTION",
      projectId: a.project.id,
      organizationId: a.organization.id,
      status: "EXECUTING",
      createdAt: new Date("2025-01-01T00:00:00Z"),
    },
  });
  const base = {
    traceId: run.traceId,
    serviceName: "test",
    serviceNamespace: "test",
    environmentId: environment.id,
    environmentType: "PRODUCTION" as const,
    organizationId: a.organization.id,
    projectId: a.project.id,
    projectRef: a.project.externalRef,
    runId: run.friendlyId,
    taskSlug: "my-task",
    properties: {},
    startTime: BigInt(Date.UTC(2025, 0, 1)) * 1_000_000n,
    duration: 1_000_000n,
  };
  await prisma.taskEvent.create({ data: { ...base, message: "my-task", spanId: run.spanId } });
  for (const n of [1, 2, 3, 4]) {
    await prisma.taskEvent.create({
      data: { ...base, message: `child-${n}`, spanId: uniqueId("child"), parentId: run.spanId },
    });
  }

  const createPat = async (userId: string) => {
    const pat = `tr_pat_${uniqueId("tok")}`;
    await prisma.personalAccessToken.create({
      data: {
        name: "mcp",
        encryptedToken: {},
        obfuscatedToken: "tr_pat_****",
        hashedToken: createHash("sha256").update(pat).digest("hex"),
        userId,
      },
    });
    return pat;
  };
  const token = await createPat(a.user.id);
  const otherToken = await createPat(b.user.id);

  const known: Record<string, string> = {
    [token]: "<PAT>",
    [a.user.email]: "<EMAIL>",
    [a.user.id]: "<USER_ID>",
    [a.organization.id]: "<ORG_ID>",
    [a.organization.slug]: "<ORG_SLUG>",
    [a.project.id]: "<PROJECT_ID>",
    [a.project.externalRef]: "<PROJECT_REF>",
    [a.project.slug]: "<PROJECT_SLUG>",
    [environment.id]: "<ENV_ID>",
    [run.friendlyId]: "<RUN_ID>",
    [run.id]: "<RUN_DB_ID>",
    [run.traceId]: "<TRACE_ID>",
    [run.spanId]: "<SPAN_ID>",
    [b.project.externalRef]: "<OTHER_PROJECT_REF>",
  };
  return {
    token,
    known,
    projectRef: a.project.externalRef,
    otherProjectRef: b.project.externalRef,
    runId: run.friendlyId,
    otherToken,
    orgIds: [a.organization.id, b.organization.id] as const,
  };
}

const listRunsFromDb = (prisma: PrismaClient) => async (environment: { id: string }) => {
  const runs = await prisma.taskRun.findMany({ where: { runtimeEnvironmentId: environment.id } });
  return {
    data: runs.map((run) => ({
      id: run.friendlyId,
      taskIdentifier: run.taskIdentifier,
      status: "EXECUTING",
      env: { name: "prod" },
      createdAt: run.createdAt,
      durationMs: 0,
      costInCents: 0,
      tags: [],
      isTest: false,
    })),
    pagination: {},
  };
};

export async function withServer(
  prisma: PrismaClient,
  fn: (baseUrl: string) => Promise<void>,
  rateLimit: RequestHandler = (_req, _res, next) => next()
) {
  // list_runs is the only tool that needs ClickHouse; swap in a Postgres-backed listRuns.
  const listRuns = createRunsTools({ listRuns: listRunsFromDb(prisma) }).find(
    (t) => t.name === "list_runs"
  )!;
  const tools = mcpTools.map((t) => (t.name === "list_runs" ? listRuns : t));
  const app = express();
  app.get(
    PRM_PATH,
    createMcpProtectedResourceHandler({
      origin: ORIGIN,
      authorizationServers: [],
      scopes: ["read:runs"],
    })
  );
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  app.use(
    "/mcp",
    createMcpRouter({
      allowedOrigin: baseUrl,
      authenticate: createMcpBearerAuthenticator({
        rbac: plugin.create(prisma, { forceFallback: true }),
        failureBody: (failure) => ({ error: failure.error, code: failure.code }),
        recheckUserActorClaims: async (claims) => claims,
        touchPat: async () => {},
        resourceMetadataUrl: `${ORIGIN}${PRM_PATH}`,
        audience: `${ORIGIN}/mcp`,
      }),
      tools,
      rateLimit,
    })
  );
  try {
    await fn(baseUrl);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

export async function capture(res: Response) {
  const headers: Record<string, string> = {};
  for (const name of ["content-type", "www-authenticate", "allow"]) {
    const value = res.headers.get(name);
    if (value) headers[name] = value;
  }
  const text = await res.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {}
  return { status: res.status, headers, body };
}
export function checkGolden(dir: string, name: string, actual: unknown) {
  const file = join(dir, `${name}.json`);
  if (process.env.UPDATE_GOLDEN === "1") {
    writeFileSync(file, `${JSON.stringify(actual, null, 2)}\n`);
    return;
  }
  if (!existsSync(file)) {
    throw new Error(`Missing golden fixture ${name}.json; run with UPDATE_GOLDEN=1`);
  }
  expect(actual, name).toEqual(JSON.parse(readFileSync(file, "utf8")));
}

export const rpc = (id: number, method: string, params: unknown = {}) => ({
  jsonrpc: "2.0",
  id,
  method,
  params,
});
export const call = (id: number, name: string, args: unknown = {}) =>
  rpc(id, "tools/call", { name, arguments: args });
