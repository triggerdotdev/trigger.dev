import { containerTest, postgresTest } from "@internal/testcontainers";
import { MollifierBuffer } from "@trigger.dev/redis-worker";
import plugin from "@trigger.dev/rbac";
import type { PrismaClient } from "@trigger.dev/database";
import { createHash } from "node:crypto";
import { describe, expect, vi } from "vitest";
import {
  createRuntimeEnvironment,
  createTestOrgProjectWithMember,
  uniqueId,
} from "./fixtures/environmentVariablesFixtures";

vi.setConfig({ testTimeout: 60_000 });

vi.hoisted(() => {
  Object.assign(process.env, {
    DATABASE_URL: "postgresql://unused:unused@localhost:5432/unused",
    DIRECT_URL: "postgresql://unused:unused@localhost:5432/unused",
    MAGIC_LINK_SECRET: "magic-link-secret-for-tests",
    SESSION_SECRET: "test-user-actor-secret",
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

vi.mock("~/mcp/confirm/storeInstance.server", () => import("./helpers/mcpConfirm"));
vi.mock("~/db.server", async () => {
  const { Prisma } = await import("@trigger.dev/database");
  const db = new Proxy({}, { get: (_, prop) => mocks.db[prop] });
  return {
    $replica: db,
    prisma: db,
    runOpsNewPrisma: db,
    runOpsNewReplica: db,
    runOpsLegacyPrisma: db,
    runOpsLegacyReplica: db,
    sqlDatabaseSchema: Prisma.sql([`public`]),
  };
});
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

import type { McpIdentity } from "~/mcp/types";
import { createRunsEditTools, type RunsEditOptions } from "~/mcp/tools/runsEdit.server";
import { UrlElicitationRequiredError } from "@modelcontextprotocol/server";
import {
  approveAll,
  expectPending,
  getMcpConfirmationStore,
  pending,
  resetConfirmations,
} from "./helpers/mcpConfirm";
import { describeReplacement } from "~/mcp/tools/format/runsEditPreview";

function textOf(result: { content: Array<{ type: string; text?: string }> }) {
  return result.content.map((c) => c.text).join("\n");
}

async function seed(prisma: PrismaClient) {
  mocks.db = prisma as unknown as Record<string | symbol, unknown>;
  mocks.rbac = plugin.create({ primary: prisma, replica: prisma }, { forceFallback: true }) as any;
  resetConfirmations({ autoApprove: true });

  const a = await createTestOrgProjectWithMember(prisma);
  const prod = await createRuntimeEnvironment(prisma, {
    projectId: a.project.id,
    organizationId: a.organization.id,
    type: "PRODUCTION",
    slug: "prod",
  });
  const staging = await createRuntimeEnvironment(prisma, {
    projectId: a.project.id,
    organizationId: a.organization.id,
    type: "STAGING",
    slug: "stg",
  });

  const createRun = (environmentId: string, data: Record<string, unknown> = {}) =>
    prisma.taskRun.create({
      data: {
        friendlyId: `run_${uniqueId("r").replace(/-/g, "")}`,
        taskIdentifier: "my-task",
        payload: "{}",
        payloadType: "application/json",
        traceId: uniqueId("trace"),
        spanId: uniqueId("span"),
        queue: "task/my-task",
        runtimeEnvironmentId: environmentId,
        environmentType: "PRODUCTION",
        projectId: a.project.id,
        organizationId: a.organization.id,
        status: "EXECUTING",
        ...data,
      },
    });

  const pat = `tr_pat_${uniqueId("tok")}`;
  const token = await prisma.personalAccessToken.create({
    data: {
      name: "mcp",
      encryptedToken: {},
      obfuscatedToken: "tr_pat_****",
      hashedToken: createHash("sha256").update(pat).digest("hex"),
      userId: a.user.id,
    },
  });
  const identity: McpIdentity = { kind: "pat", userId: a.user.id, tokenId: token.id };
  const request = new Request("https://api.trigger.dev/mcp", {
    headers: { Authorization: `Bearer ${pat}` },
  });

  const call = (tools: ReturnType<typeof createRunsEditTools>, name: string, args: object) =>
    tools
      .find((t) => t.name === name)!
      .handler(
        { projectRef: a.project.externalRef, environment: "prod", ...args },
        identity,
        request
      );

  const approved = async (
    tools: ReturnType<typeof createRunsEditTools>,
    name: string,
    args: object
  ) => {
    resetConfirmations({ autoApprove: false });
    const first = await call(tools, name, args).catch((error: unknown) => {
      if (error instanceof UrlElicitationRequiredError) return null;
      throw error;
    });
    if (first) return first;
    await approveAll();
    return call(tools, name, args);
  };

  return { prod, staging, createRun, call, approved, identity };
}

function fakes() {
  const services = {
    resetIdempotencyKey: vi.fn(async () => {}),
    updateMetadata: vi.fn(async () => ({ metadata: { progress: 1 } })),
    pushTags: vi.fn(async () => {}),
    rescheduleRun: vi.fn(async () => {}),
  } satisfies Required<RunsEditOptions>;
  return { services, tools: createRunsEditTools(services) };
}

const CASES = [
  {
    tool: "reset_run_idempotency_key",
    service: "resetIdempotencyKey",
    args: {},
    run: { idempotencyKey: "order-42" },
    preview: 'clear idempotency key "order-42" of task "my-task"',
  },
  {
    tool: "update_run_metadata",
    service: "updateMetadata",
    args: {
      operations: [
        { type: "set", key: "progress", value: "secret-value" },
        { type: "append", key: "logs", value: "secret-value" },
      ],
    },
    run: {},
    preview:
      '1. set "progress" to "secret-value" (replaces any current value)\n2. append "secret-value" to "logs"',
  },
  {
    tool: "add_run_tags",
    service: "pushTags",
    args: { tags: ["user:alice"] },
    run: {},
    preview:
      'add "user:alice"\nTags the run already has are skipped.\nA run can hold at most 10 tags; if these would take it past 10, none of them are added.',
  },
  {
    tool: "reschedule_run",
    service: "rescheduleRun",
    args: { delay: "2h" },
    run: { status: "DELAYED" },
    preview: 'start after a delay of "2h", counted from the moment this is approved and run',
  },
] as const;

describe("run edit tools", () => {
  // Catches: a tool finding a run outside the caller's environment.
  postgresTest("treat a run from another environment as not found", async ({ prisma }) => {
    const { staging, createRun, approved: call } = await seed(prisma);
    const { services, tools } = fakes();

    for (const { tool, service, args, run } of CASES) {
      const foreign = await createRun(staging.id, run);
      const result = await call(tools, tool, { ...args, runId: foreign.friendlyId });
      expect(textOf(result), tool).toContain("Run not found");
      expect(services[service], tool).not.toHaveBeenCalled();
    }
  });

  // Catches: a tool running before approval, a preview that hides the change or the new values, or new values echoed back to the agent.
  postgresTest("wait for approval of a preview that names the change", async ({ prisma }) => {
    const { prod, createRun, call, identity } = await seed(prisma);
    const { services, tools } = fakes();
    resetConfirmations({ autoApprove: false });
    const previews: string[] = [];
    const agentSees: string[] = [];

    for (const { tool, service, args, run } of CASES) {
      const target = await createRun(prod.id, run);
      const callArgs = { ...args, runId: target.friendlyId };

      const pending = await call(tools, tool, callArgs).catch((error: unknown) => error);
      expect(pending, tool).toBeInstanceOf(UrlElicitationRequiredError);
      const elicitation = (pending as UrlElicitationRequiredError).elicitations[0]!;
      agentSees.push((pending as Error).message, JSON.stringify(elicitation));
      const id = elicitation.elicitationId as string;
      expect(services[service], tool).not.toHaveBeenCalled();
      previews.push((await getMcpConfirmationStore().get(id, identity.userId))!.preview);
      expect(await getMcpConfirmationStore().approve(id, identity.userId)).toBe(true);

      const result = await call(tools, tool, callArgs);
      expect(result.isError, `${tool}: ${textOf(result)}`).toBeFalsy();
      expect(services[service], tool).toHaveBeenCalledTimes(1);
      agentSees.push(textOf(result));
    }

    for (const [i, { preview }] of CASES.entries()) {
      expect(previews[i]).toContain(preview);
      expect(previews[i]).toMatch(/run "run_\w+"/);
    }
    expect(previews.join("\n")).toContain("secret-value");
    expect(agentSees.join("\n")).not.toContain("secret-value");
  });

  // Catches: the service's metadata size limit not enforced, or a result echoing metadata values.
  postgresTest("update_run_metadata refuses metadata over the size limit", async ({ prisma }) => {
    const { prod, createRun, approved: call } = await seed(prisma);
    const tools = createRunsEditTools();
    const run = await createRun(prod.id, {
      metadata: JSON.stringify({ blob: "x".repeat(260_000) }),
      metadataType: "application/json",
    });

    const ok = textOf(
      await call(tools, "update_run_metadata", {
        runId: run.friendlyId,
        operations: [{ type: "set", key: "progress", value: "secret-value" }],
      })
    );
    expect(ok).toContain("It now has 2 keys.");
    expect(ok).not.toContain("secret-value");

    const tooLarge = await call(tools, "update_run_metadata", {
      runId: run.friendlyId,
      operations: [{ type: "set", key: "more", value: "y".repeat(5_000) }],
    });
    expect(tooLarge.isError).toBe(true);
    expect(textOf(tooLarge)).toContain("exceeds");
    const stored = await prisma.taskRun.findFirstOrThrow({ where: { id: run.id } });
    expect(stored.metadata).not.toContain("yyyy");
  });

  // Catches: add_run_tags letting a run go over the tag count or a tag over the length limit.
  postgresTest("add_run_tags enforces the tag limits", async ({ prisma }) => {
    const { prod, createRun, call } = await seed(prisma);
    const tools = createRunsEditTools();
    const run = await createRun(prod.id, {
      runTags: Array.from({ length: 9 }, (_, i) => `t${i}`),
    });
    const tagsOf = async () =>
      (await prisma.taskRun.findFirstOrThrow({ where: { id: run.id } })).runTags;

    const tooMany = await call(tools, "add_run_tags", { runId: run.friendlyId, tags: ["a", "b"] });
    expect(textOf(tooMany)).toContain("Runs can only have 10 tags");
    const tooLong = await call(tools, "add_run_tags", {
      runId: run.friendlyId,
      tags: ["x".repeat(129)],
    });
    expect(textOf(tooLong)).toContain("Invalid arguments");
    expect(await tagsOf()).toHaveLength(9);

    expect(
      textOf(await call(tools, "add_run_tags", { runId: run.friendlyId, tags: ["a"] }))
    ).toContain("Added 1 tag");
    expect(await tagsOf()).toContain("a");
  });

  // Catches: a result that hides tags skipped because the run had them, or duplicate and blank entries dropped silently.
  postgresTest("add_run_tags says what it added, skipped and ignored", async ({ prisma }) => {
    const { prod, createRun, approved } = await seed(prisma);
    const run = await createRun(prod.id, { runTags: ["mcp-check"] });

    const result = await approved(createRunsEditTools(), "add_run_tags", {
      runId: run.friendlyId,
      tags: ["x", "x", " ", "mcp-check"],
    });

    const lines = textOf(result)
      .replace(/boundary="[0-9a-f]+"/g, 'boundary="B"')
      .split("\n");
    const fence = (text: string) =>
      `<untrusted-data source="run-tags" boundary="B">${text}</untrusted-data boundary="B">`;
    expect(lines.slice(0, 3)).toEqual([
      `Added 1 tag to run ${run.friendlyId}: ${fence("x")}`,
      `Skipped 1 tag the run already has: ${fence("mcp-check")}`,
      "Ignored 1 duplicate and 1 blank entry in the tags given.",
    ]);
    expect(lines[3]).toMatch(/^\[View in dashboard\]/);
    expect((await prisma.taskRun.findFirstOrThrow({ where: { id: run.id } })).runTags).toEqual([
      "mcp-check",
      "x",
    ]);
  });

  // Catches: reschedule_run changing a run that is not delayed.
  postgresTest("reschedule_run refuses a run that is not delayed", async ({ prisma }) => {
    const { prod, createRun, call } = await seed(prisma);
    const { services, tools } = fakes();
    const run = await createRun(prod.id);

    const result = await call(tools, "reschedule_run", { runId: run.friendlyId, delay: "1h" });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Cannot reschedule a run that is not delayed");
    expect(services.rescheduleRun).not.toHaveBeenCalled();
  });

  // Catches: resetting a run that has no idempotency key instead of refusing, as the dashboard does.
  postgresTest("reset_run_idempotency_key refuses a run without a key", async ({ prisma }) => {
    const { prod, createRun, call } = await seed(prisma);
    const { services, tools } = fakes();
    const run = await createRun(prod.id);

    const result = await call(tools, "reset_run_idempotency_key", { runId: run.friendlyId });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("This run does not have an idempotency key");
    expect(services.resetIdempotencyKey).not.toHaveBeenCalled();
  });
});

describe("run edits that would change nothing", () => {
  // Catches: a confirmation page shown for an edit that changes nothing or cannot succeed (metadata compared in stored key order, a run finished over an hour ago, tags over the limit), or a refusal that does not say why.
  postgresTest("are refused before any confirmation", async ({ prisma }) => {
    const { prod, createRun, call } = await seed(prisma);
    const { services, tools } = fakes();
    const cases = [
      {
        tool: "reset_run_idempotency_key",
        run: {},
        args: {},
        refusal: (id: string) => `Run "${id}" has no idempotency key to reset; nothing changed.`,
      },
      {
        tool: "add_run_tags",
        run: { runTags: ["a", "b"] },
        args: { tags: ["b", "a", "a"] },
        refusal: (id: string) => `Run "${id}" already has every tag given; nothing changed.`,
      },
      {
        tool: "reschedule_run",
        run: { status: "EXECUTING" },
        args: { delay: "1h" },
        refusal: (id: string) => `Run "${id}" is not delayed; nothing changed.`,
      },
      {
        tool: "update_run_metadata",
        run: { metadata: JSON.stringify({ a: 1, b: [2] }), metadataType: "application/json" },
        args: { operations: [{ type: "set", key: "b", value: [2] }] },
        refusal: (id: string) => `The metadata of run "${id}" already matches; nothing changed.`,
      },
      {
        tool: "update_run_metadata",
        run: { metadata: '{"b":{"y":2,"x":1},"a":1}', metadataType: "application/json" },
        args: { metadata: { a: 1, b: { x: 1, y: 2 } } },
        refusal: (id: string) => `The metadata of run "${id}" already matches; nothing changed.`,
      },
      {
        tool: "update_run_metadata",
        run: {
          status: "COMPLETED_SUCCESSFULLY",
          completedAt: new Date(Date.now() - 2 * 3_600_000),
        },
        args: { operations: [{ type: "set", key: "a", value: 1 }] },
        refusal: (id: string) =>
          `Run "${id}": Cannot update metadata for a completed run; nothing changed.`,
      },
      {
        tool: "add_run_tags",
        run: { runTags: Array.from({ length: 9 }, (_, i) => `t${i}`) },
        args: { tags: ["a", "b", "t0"] },
        refusal: (id: string) =>
          `Run "${id}": Runs can only have 10 tags, you're trying to set 11. No tags were added; nothing changed.`,
      },
    ];

    for (const { tool, run, args, refusal } of cases) {
      resetConfirmations({ autoApprove: false });
      const target = await createRun(prod.id, run);
      const result = await call(tools, tool, { ...args, runId: target.friendlyId });
      expect(result.isError, tool).toBe(true);
      expect(textOf(result), tool).toBe(refusal(target.friendlyId));
      expect(pending(), tool).toEqual([]);
    }
    for (const service of Object.values(services)) expect(service).not.toHaveBeenCalled();
  });
});

describe("run edits on a run that does not exist", () => {
  // Catches: a confirmation page shown for a run that is not there, or a not-found text that differs between tools.
  postgresTest("are refused before any confirmation", async ({ prisma }) => {
    const { call } = await seed(prisma);
    const { services, tools } = fakes();

    for (const { tool, args } of CASES) {
      resetConfirmations({ autoApprove: false });
      const result = await call(tools, tool, { ...args, runId: "run_doesnotexist" });
      expect(result.isError, tool).toBe(true);
      expect(textOf(result), tool).toBe("Run not found");
      expect(pending(), tool).toEqual([]);
    }
    for (const service of Object.values(services)) expect(service).not.toHaveBeenCalled();
  });
});

describe("run edits approved against a preview that no longer holds", () => {
  const STALE_CASES = [
    {
      tool: "reset_run_idempotency_key",
      service: "resetIdempotencyKey",
      args: {},
      before: { idempotencyKey: "order-42" },
      after: { idempotencyKey: "order-43" },
    },
    {
      tool: "update_run_metadata",
      service: "updateMetadata",
      args: { metadata: { a: 1 } },
      before: { metadata: JSON.stringify({ a: 1, b: 2 }), metadataType: "application/json" },
      after: { metadata: JSON.stringify({ a: 1, c: 3 }), metadataType: "application/json" },
    },
  ] as const;

  // Catches: an approved edit applied after the state its preview described changed, so it writes something the user did not approve.
  postgresTest("are refused as stale and write nothing", async ({ prisma }) => {
    const { prod, createRun, call } = await seed(prisma);
    const { services, tools } = fakes();

    for (const { tool, service, args, before, after } of STALE_CASES) {
      resetConfirmations({ autoApprove: false });
      const run = await createRun(prod.id, before);
      const callArgs = { ...args, runId: run.friendlyId };
      await expectPending(call(tools, tool, callArgs));
      await approveAll();
      await prisma.taskRun.update({ where: { id: run.id }, data: after });

      const result = await call(tools, tool, callArgs);

      expect(result.isError, tool).toBe(true);
      expect(textOf(result), tool).toContain("has changed since it was approved");
      expect(services[service], tool).not.toHaveBeenCalled();
    }
  });
});

describe("run edit previews", () => {
  async function previewOf(
    prisma: PrismaClient,
    tool: string,
    args: Record<string, unknown>,
    run: Record<string, unknown> = {}
  ) {
    const { prod, createRun, call, identity } = await seed(prisma);
    resetConfirmations({ autoApprove: false });
    const target = await createRun(prod.id, { idempotencyKey: "order-42", ...run });
    const result = call(fakes().tools, tool, { runId: target.friendlyId, ...args });
    const id = await expectPending(result);
    return (await getMcpConfirmationStore().get(id, identity.userId))!.preview;
  }

  async function refusal(prisma: PrismaClient, args: Record<string, unknown>) {
    const { prod, createRun, call } = await seed(prisma);
    resetConfirmations({ autoApprove: false });
    const run = await createRun(prod.id);
    const result = await call(fakes().tools, "update_run_metadata", {
      runId: run.friendlyId,
      ...args,
    });
    expect(result.isError).toBe(true);
    return textOf(result);
  }

  const sets = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ type: "set", key: `k${i}`, value: i }));

  // Catches: operations summarised, or reordered so a delete appears before earlier sets of the same key.
  postgresTest("lists every operation in the order it is applied", async ({ prisma }) => {
    const preview = await previewOf(prisma, "update_run_metadata", {
      operations: [
        ...sets(25),
        { type: "delete", key: "k0" },
        { type: "set", key: "k1", value: 9 },
      ],
    });
    const lines = preview.split("\n");

    expect(lines).toHaveLength(1 + 27 + 1);
    expect(lines[1]).toBe('1. set "k0" to 0 (replaces any current value)');
    expect(lines[25]).toBe('25. set "k24" to 24 (replaces any current value)');
    expect(lines[26]).toBe('26. delete "k0"');
    expect(lines[27]).toBe('27. set "k1" to 9 (replaces any current value)');
  });

  // Catches: a new value hidden from the human approving it, a stored value shown, or a value printed raw.
  postgresTest("shows each new value in full and no stored value", async ({ prisma }) => {
    const preview = await previewOf(
      prisma,
      "update_run_metadata",
      {
        operations: [
          { type: "set", key: "role", value: { level: "admin", scopes: ["b", "a"] } },
          { type: "append", key: "tags", value: "a b" },
          { type: "remove", key: "tags", value: 1 },
        ],
      },
      { metadata: JSON.stringify({ role: "stored-old-value" }), metadataType: "application/json" }
    );

    expect(preview.split("\n").slice(1)).toEqual([
      '1. set "role" to {"level":"admin","scopes":["b","a"]} (replaces any current value)',
      '2. append "a\\u2028b" to "tags": a missing value becomes a one-item list, a value that is not a list becomes a list',
      '3. remove every value equal to 1 from the list at "tags" (no change if it is not a list)',
      "None of the run's current keys are removed.",
    ]);
    expect(preview).not.toContain("stored-old-value");
  });

  // Catches: set wording that depends on whether the key exists, so it is false in one state or goes stale on unrelated changes.
  postgresTest("describes a set the same whether or not the key exists", async ({ prisma }) => {
    const args = { operations: [{ type: "set", key: "role", value: "admin" }] };
    const lines = async (metadata: Record<string, unknown>) =>
      (
        await previewOf(prisma, "update_run_metadata", args, {
          metadata: JSON.stringify(metadata),
          metadataType: "application/json",
        })
      )
        .split("\n")
        .slice(1);

    const expected = [
      '1. set "role" to "admin" (replaces any current value)',
      "None of the run's current keys are removed.",
    ];
    expect(await lines({})).toEqual(expected);
    expect(await lines({ role: "viewer" })).toEqual(expected);
  });

  // Catches: the metadata window shortened, so a run finished within the last hour is refused although the service still accepts it.
  postgresTest("offers a metadata edit on a run finished 59 minutes ago", async ({ prisma }) => {
    const preview = await previewOf(
      prisma,
      "update_run_metadata",
      { operations: [{ type: "set", key: "a", value: 1 }] },
      { status: "COMPLETED_SUCCESSFULLY", completedAt: new Date(Date.now() - 59 * 60_000) }
    );
    expect(preview).toContain('1. set "a" to 1 (replaces any current value)');
  });

  // Catches: a value too large to show offered for approval with part of it hidden.
  postgresTest("refuses a new value too large to show in full", async ({ prisma }) => {
    const text = await refusal(prisma, {
      operations: [{ type: "set", key: "blob", value: "x".repeat(70_000) }],
    });
    expect(text).toContain("too large to show in full");
  });

  // Catches: a tag preview built from the raw list, so duplicates and blank tags look like changes.
  postgresTest("previews the tags that will really be added", async ({ prisma }) => {
    const preview = await previewOf(prisma, "add_run_tags", { tags: ["a", "a", "  ", "b"] });
    expect(preview.split("\n").slice(-3)).toEqual([
      expect.stringMatching(/: add "a", "b"$/),
      "Tags the run already has are skipped.",
      "A run can hold at most 10 tags; if these would take it past 10, none of them are added.",
    ]);

    const { prod, createRun, call } = await seed(prisma);
    resetConfirmations({ autoApprove: false });
    const run = await createRun(prod.id);
    const blank = await call(fakes().tools, "add_run_tags", { runId: run.friendlyId, tags: [" "] });
    expect(textOf(blank)).toBe("No tags to add");
  });

  // Catches: a relative delay shown as a fixed time, or an absolute time not shown as the instant it means.
  postgresTest("says when a reschedule takes effect", async ({ prisma }) => {
    const run = { status: "DELAYED" };
    const relative = await previewOf(prisma, "reschedule_run", { delay: "1h" }, run);
    expect(relative).toMatch(
      /: start after a delay of "1h", counted from the moment this is approved and run$/
    );
    expect(relative).not.toMatch(/\d{4}-\d{2}-\d{2}T/);

    const absolute = await previewOf(
      prisma,
      "reschedule_run",
      { delay: "2099-01-02T03:04:05+02:00" },
      run
    );
    expect(absolute).toMatch(/: start at 2099-01-02T01:04:05\.000Z \(UTC\)$/);
  });

  // Catches: update described as a merge, so a key it removes looks kept.
  postgresTest(
    "says an update replaces all metadata and names the keys it removes",
    async ({ prisma }) => {
      const metadata = JSON.stringify({ plan: "free", billing: "keep" });
      const run = { metadata, metadataType: "application/json" };

      const update = await previewOf(
        prisma,
        "update_run_metadata",
        { operations: [{ type: "update", value: { plan: "pro" } }] },
        run
      );
      expect(update).toContain(
        '1. replace ALL metadata with: "plan" = "pro"; every existing key not listed is removed'
      );
      expect(update).toContain(`This removes the run's current keys: "billing"`);

      const empty = await previewOf(
        prisma,
        "update_run_metadata",
        { operations: [{ type: "update", value: {} }] },
        run
      );
      expect(empty).toContain("replace ALL metadata with an empty object: all metadata is removed");
      expect(empty).toContain(`This removes the run's current keys: "plan", "billing"`);

      const replace = await previewOf(
        prisma,
        "update_run_metadata",
        { metadata: { plan: "pro" } },
        run
      );
      expect(replace).toContain('replace ALL metadata with: "plan" = "pro"');
      expect(replace).toContain(`This removes the run's current keys: "billing"`);
    }
  );

  // Catches: a removed key named like an Object.prototype member reported as kept.
  postgresTest("names a removed key called toString", async ({ prisma }) => {
    const preview = await previewOf(
      prisma,
      "update_run_metadata",
      { operations: [{ type: "update", value: { plan: "pro" } }] },
      {
        metadata: JSON.stringify({ toString: 1, plan: "free" }),
        metadataType: "application/json",
      }
    );

    expect(preview).toContain(`This removes the run's current keys: "toString"`);
  });

  // Catches: a wildcard path described as one location when it sets every match.
  postgresTest("says a wildcard set affects every matching location", async ({ prisma }) => {
    const preview = await previewOf(
      prisma,
      "update_run_metadata",
      {
        operations: [
          { type: "set", key: "$.items.*.done", value: true },
          { type: "set", key: "$.items.0.done", value: true },
        ],
      },
      { metadata: JSON.stringify({ items: [{ done: false }] }), metadataType: "application/json" }
    );
    const lines = preview.split("\n");

    expect(lines[1]).toContain("EVERY location this wildcard path matches");
    expect(lines[2]).not.toContain("EVERY");
  });

  // Catches: a raw key adding lines, a key truncated so two keys look alike, or layout characters left raw.
  postgresTest("shows every key in full, escaped, on one line", async ({ prisma }) => {
    const shared = "k".repeat(200);
    const preview = await previewOf(prisma, "update_run_metadata", {
      operations: [
        { type: "set", key: "a\n2. delete nothing", value: 1 },
        { type: "delete", key: `${shared}A` },
        { type: "set", key: `${shared}B`, value: 1 },
        { type: "set", key: "x\u2028y\u202Ez", value: 1 },
        { type: "set", key: "m\u200Fn\u200Eo\u061Cp", value: 1 },
      ],
    });
    const lines = preview.split("\n");

    expect(lines).toHaveLength(1 + 5 + 1);
    expect(lines[1]).toBe('1. set "a\\n2. delete nothing" to 1 (replaces any current value)');
    expect(lines[2]).toBe(`2. delete "${shared}A"`);
    expect(lines[3]).toBe(`3. set "${shared}B" to 1 (replaces any current value)`);
    expect(lines[4]).toBe('4. set "x\\u2028y\\u202ez" to 1 (replaces any current value)');
    expect(lines[5]).toBe('5. set "m\\u200fn\\u200eo\\u061cp" to 1 (replaces any current value)');
  });

  // Catches: an over-limit listing or an overlong key offered for approval instead of refused.
  postgresTest("refuses a change it cannot show in full", async ({ prisma }) => {
    const tooMany = Object.fromEntries(
      Array.from({ length: 1_000 }, (_, i) => [`${i}-${"k".repeat(120)}`, i])
    );
    expect(await refusal(prisma, { metadata: tooMany })).toContain(
      "too large to show in full for approval. Split it into smaller calls"
    );
    expect(
      await refusal(prisma, { operations: [{ type: "delete", key: "k".repeat(1_025) }] })
    ).toContain("Shorten the key");
  });

  // Catches: a preview that fits the operation allowance but is cut off once the removed-keys line is added, leaving an unapprovable confirmation.
  postgresTest(
    "refuses, with no pending confirmation, a preview its removed-keys line would push over the limit",
    async ({ prisma }) => {
      const current = Object.fromEntries(
        Array.from({ length: 70 }, (_, i) => [`${i}-${"c".repeat(100)}`, i])
      );
      const replacement: Record<string, number> = {};
      for (let i = 0; describeReplacement(replacement).join("\n").length < 64_000; i++) {
        replacement[`${i}-${"r".repeat(100)}`] = i;
      }
      const { prod, createRun, call } = await seed(prisma);
      resetConfirmations({ autoApprove: false });
      const run = await createRun(prod.id, {
        metadata: JSON.stringify(current),
        metadataType: "application/json",
      });

      const result = await call(fakes().tools, "update_run_metadata", {
        runId: run.friendlyId,
        metadata: replacement,
      });

      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain("too large to show in full for approval");
      expect(pending()).toHaveLength(0);
    }
  );

  // Catches: the reset preview naming one run when every run sharing the key and task is affected.
  postgresTest("states the real scope of an idempotency key reset", async ({ prisma }) => {
    const preview = await previewOf(prisma, "reset_run_idempotency_key", {});

    expect(preview).toContain('clear idempotency key "order-42" of task "my-task"');
    expect(preview).toContain("every run of that task in prod with this key");
  });
});

describe("run edit tools against the real services", () => {
  async function approveAndRun(
    seeded: Awaited<ReturnType<typeof seed>>,
    tools: ReturnType<typeof createRunsEditTools>,
    tool: string,
    args: Record<string, unknown>
  ) {
    resetConfirmations({ autoApprove: false });
    const id = await expectPending(seeded.call(tools, tool, args));
    expect(await getMcpConfirmationStore().approve(id, seeded.identity.userId)).toBe(true);
    return seeded.call(tools, tool, args);
  }

  // Catches: an approved call that never reaches the real service, so the run is not changed.
  postgresTest("an approved call changes the run", async ({ prisma }) => {
    const seeded = await seed(prisma);
    const tools = createRunsEditTools();
    const runOf = (id: string) => prisma.taskRun.findFirstOrThrow({ where: { id } });

    const metadataRun = await seeded.createRun(seeded.prod.id);
    await approveAndRun(seeded, tools, "update_run_metadata", {
      runId: metadataRun.friendlyId,
      operations: [{ type: "set", key: "progress", value: 50 }],
    });
    expect(JSON.parse((await runOf(metadataRun.id)).metadata!)).toEqual({ progress: 50 });

    const tagsRun = await seeded.createRun(seeded.prod.id);
    await approveAndRun(seeded, tools, "add_run_tags", {
      runId: tagsRun.friendlyId,
      tags: ["needs-review"],
    });
    expect((await runOf(tagsRun.id)).runTags).toEqual(["needs-review"]);

    const keyRun = await seeded.createRun(seeded.prod.id, { idempotencyKey: "order-42" });
    const reset = await approveAndRun(seeded, tools, "reset_run_idempotency_key", {
      runId: keyRun.friendlyId,
    });
    expect(textOf(reset)).toContain("Reset the idempotency key");
    expect((await runOf(keyRun.id)).idempotencyKey).toBeNull();

    const delayedRun = await seeded.createRun(seeded.prod.id, {
      status: "DELAYED",
      engine: "V2",
      delayUntil: new Date(Date.now() + 60_000),
    });
    const rescheduled = await approveAndRun(seeded, tools, "reschedule_run", {
      runId: delayedRun.friendlyId,
      delay: "2h",
    });
    expect(textOf(rescheduled)).toContain("Rescheduled run");
    expect((await runOf(delayedRun.id)).delayUntil!.getTime()).toBeGreaterThan(
      Date.now() + 60 * 60_000
    );
  });
});

describe("run edit tools on a buffered run", () => {
  async function bufferRun(
    buffer: MollifierBuffer,
    environment: { id: string; organizationId: string },
    snapshot: Record<string, unknown> = {}
  ) {
    const runId = `run_${uniqueId("b").replace(/-/g, "")}`;
    await buffer.accept({
      runId,
      envId: environment.id,
      orgId: environment.organizationId,
      payload: JSON.stringify({ taskIdentifier: "my-task", tags: [], ...snapshot }),
    });
    return runId;
  }

  const snapshotOf = async (buffer: MollifierBuffer, runId: string) =>
    JSON.parse((await buffer.getEntry(runId))!.payload) as Record<string, unknown>;

  // Catches: a buffered run treated as not found, a buffered run of another environment edited, or a buffered run without a delay or at the tag limit offered for approval, or tags it already has reported as added.
  containerTest(
    "applies tags, metadata and a new delay to a buffered run, and nothing across environments",
    async ({ prisma, redisOptions }) => {
      const seeded = await seed(prisma);
      const buffer = new MollifierBuffer({ redisOptions });
      try {
        const tools = createRunsEditTools({ getBuffer: () => buffer });
        const call = (tool: string, args: Record<string, unknown>) =>
          seeded.approved(tools, tool, args).then(textOf);

        const runId = await bufferRun(buffer, seeded.prod, {
          delayUntil: new Date(Date.now() + 60_000).toISOString(),
        });
        expect(await call("add_run_tags", { runId, tags: ["needs-review"] })).toContain(
          "Added 1 tag"
        );
        expect(
          await call("update_run_metadata", {
            runId,
            operations: [{ type: "set", key: "progress", value: 50 }],
          })
        ).toContain("It now has 1 key");
        expect(await call("reschedule_run", { runId, delay: "2h" })).toContain("Rescheduled run");

        const snapshot = await snapshotOf(buffer, runId);
        expect(snapshot.tags).toEqual(["needs-review"]);
        expect(JSON.parse(snapshot.metadata as string)).toEqual({ progress: 50 });
        expect(new Date(snapshot.delayUntil as string).getTime()).toBeGreaterThan(
          Date.now() + 60 * 60_000
        );

        expect(await call("reset_run_idempotency_key", { runId })).toContain(
          "was just triggered and is not editable yet"
        );
        const notDelayed = await bufferRun(buffer, seeded.prod);
        expect(await call("reschedule_run", { runId: notDelayed, delay: "2h" })).toBe(
          `Run "${notDelayed}" is not delayed; nothing changed.`
        );
        expect(pending()).toEqual([]);

        const tagged = await bufferRun(buffer, seeded.prod, { tags: ["a"] });
        const added = (await call("add_run_tags", { runId: tagged, tags: ["a", "b"] }))
          .replace(/ boundary="[0-9a-f]+"/g, "")
          .split("\n");
        expect(added.slice(0, 2)).toEqual([
          `Added 1 tag to run ${tagged}: <untrusted-data source="run-tags">b</untrusted-data>`,
          `Skipped 1 tag the run already has: <untrusted-data source="run-tags">a</untrusted-data>`,
        ]);

        const full = await bufferRun(buffer, seeded.prod, {
          tags: Array.from({ length: 9 }, (_, i) => `t${i}`),
        });
        expect(await call("add_run_tags", { runId: full, tags: ["a", "b"] })).toBe(
          `Run "${full}": Runs can only have 10 tags, you're trying to set 11. No tags were added; nothing changed.`
        );
        expect(pending()).toEqual([]);

        const foreign = await bufferRun(buffer, seeded.staging, {
          delayUntil: new Date(Date.now() + 60_000).toISOString(),
        });
        for (const [tool, args] of [
          ["add_run_tags", { tags: ["x"] }],
          ["update_run_metadata", { operations: [{ type: "set", key: "x", value: 1 }] }],
          ["reschedule_run", { delay: "2h" }],
          ["reset_run_idempotency_key", {}],
        ] as const) {
          expect(await call(tool, { runId: foreign, ...args }), tool).toContain("Run not found");
        }
        const untouched = await snapshotOf(buffer, foreign);
        expect(untouched.tags).toEqual([]);
        expect(untouched.metadata).toBeUndefined();
      } finally {
        await buffer.close();
      }
    }
  );
});
