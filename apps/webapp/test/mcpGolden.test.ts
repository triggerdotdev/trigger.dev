import { postgresTest } from "@internal/testcontainers";
import type { PrismaClient } from "@trigger.dev/database";
import plugin from "@trigger.dev/rbac";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 60_000 });

vi.hoisted(() => {
  Object.assign(process.env, {
    DATABASE_URL: "postgresql://unused:unused@localhost:5432/unused",
    DIRECT_URL: "postgresql://unused:unused@localhost:5432/unused",
    MAGIC_LINK_SECRET: "magic-link-secret-for-tests",
    ENCRYPTION_KEY: "0123456789abcdef0123456789abcdef",
    DEPLOY_REGISTRY_HOST: "registry.test",
    V4_DEPLOY_REGISTRY_HOST: "registry.test",
    CLICKHOUSE_URL: "http://localhost:8123",
  });
});

const mocks = vi.hoisted(() => ({
  db: undefined as unknown as Record<string | symbol, unknown>,
  rbac: undefined as unknown as Record<string, (...args: any[]) => any>,
}));

vi.mock("~/db.server", () => ({
  $replica: new Proxy({}, { get: (_, prop) => mocks.db[prop] }),
  prisma: new Proxy({}, { get: (_, prop) => mocks.db[prop] }),
}));
vi.mock("~/v3/webhookEngine.server", () => ({ webhookEngine: {} }));
vi.mock("~/services/rbac.server", () => ({
  rbac: new Proxy(
    {},
    {
      get:
        (_, prop: string) =>
        (...args: unknown[]) =>
          mocks.rbac[prop](...args),
    }
  ),
}));

import {
  call,
  capture,
  checkGolden,
  normalize,
  rpc,
  seed as seedData,
  withServer,
} from "./fixtures/mcpHarness";

const PROTOCOL_VERSION = "2025-11-25";
const FIXTURES_DIR = join(__dirname, "fixtures/mcp-golden", PROTOCOL_VERSION);

async function seed(prisma: PrismaClient) {
  mocks.db = prisma as unknown as Record<string | symbol, unknown>;
  mocks.rbac = plugin.create({ primary: prisma, replica: prisma }, { forceFallback: true }) as any;
  return seedData(prisma);
}

describe("normalize", () => {
  it("replaces known values and volatile fields with stable placeholders", () => {
    const out = normalize(
      {
        run_1: [
          'cursor: "abc123" <untrusted-data source="x" boundary="0123456789abcdef01234567">',
          "at 2025-01-02T03:04:05.678Z id cabcdefghijklmnopqrstuvwx",
        ],
      },
      { run_1: "<RUN_ID>" }
    );

    expect(out).toEqual({
      "<RUN_ID>": [
        'cursor: "<CURSOR>" <untrusted-data source="x" boundary="<BOUNDARY>">',
        "at <TIMESTAMP> id <CUID>",
      ],
    });
  });
});

describe("MCP golden transcripts", () => {
  // Catches: a changed tool title, a tool dropped from the registry, or a changed 401 body.
  postgresTest(`protocol ${PROTOCOL_VERSION} responses match the fixtures`, async ({ prisma }) => {
    const { token, known, projectRef, otherProjectRef, runId } = await seed(prisma);
    const scope = { projectRef, environment: "prod" };

    await withServer(prisma, async (baseUrl) => {
      const post = (body: unknown, auth: string | null = token) =>
        fetch(`${baseUrl}/mcp`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json, text/event-stream",
            ...(auth ? { Authorization: `Bearer ${auth}` } : {}),
          },
          body: typeof body === "string" ? body : JSON.stringify(body),
        });

      const rpcCases = [
        {
          name: "initialize",
          request: rpc(1, "initialize", {
            protocolVersion: PROTOCOL_VERSION,
            capabilities: {},
            clientInfo: { name: "golden", version: "1.0.0" },
          }),
        },
        { name: "tools-list", request: rpc(2, "tools/list") },
        { name: "call-list-projects", request: call(3, "list_projects") },
        { name: "call-list-runs", request: call(4, "list_runs", scope) },
        {
          name: "call-get-run-details",
          request: call(5, "get_run_details", { ...scope, runId, maxTraceLines: 3 }),
        },
        {
          name: "call-get-task-schema",
          request: call(6, "get_task_schema", { ...scope, taskSlug: "my-task" }),
        },
        { name: "error-unknown-tool", request: call(7, "no_such_tool") },
        {
          name: "error-cross-tenant-project",
          request: call(8, "list_runs", { ...scope, projectRef: otherProjectRef }),
        },
      ].map(({ name, request }) => ({ name, request, send: () => post(request) }));

      const cases = [
        ...rpcCases,
        {
          name: "error-no-bearer",
          request: rpc(9, "tools/list"),
          send: () => post(rpc(9, "tools/list"), null),
        },
        {
          name: "error-get-not-allowed",
          request: { method: "GET" },
          send: () => fetch(`${baseUrl}/mcp`),
        },
        {
          name: "error-malformed-json",
          request: { rawBody: "{not json" },
          send: () => post("{not json"),
        },
        {
          name: "error-empty-body",
          request: { rawBody: "" },
          send: () => post(""),
        },
        {
          name: "error-body-too-large",
          request: { rawBody: "1 MiB + 1 byte of padding" },
          send: () => post(JSON.stringify({ pad: "x".repeat(1024 * 1024) })),
        },
      ];

      for (const { name, request, send } of cases) {
        const response = await capture(await send());
        checkGolden(FIXTURES_DIR, name, normalize({ request, response }, known));
        if (name === "tools-list") {
          const { tools } = (response.body as { result: { tools: Record<string, any>[] } }).result;
          for (const tool of tools) {
            expect(tool, tool.name).not.toHaveProperty("execution");
            expect(tool.inputSchema.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
          }
        }
      }
    });
  });
});
