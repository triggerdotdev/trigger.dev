import { afterEach, describe, expect, vi } from "vitest";
import type { PrismaClient } from "@trigger.dev/database";
import { spawnSync } from "node:child_process";

// External HTTP is stubbed intentionally for rollout verification.
// Route/repository singletons use the same real, isolated Testcontainers database.
const database = vi.hoisted(() => ({ client: undefined as PrismaClient | undefined }));
vi.mock("~/db.server", async () => {
  const actual = await import("@trigger.dev/database");
  const proxy = new Proxy(
    {},
    {
      get(_target, property) {
        const client = database.client;
        if (!client) throw new Error("Test database not connected");
        const value = Reflect.get(client, property);
        return typeof value === "function" ? value.bind(client) : value;
      },
    }
  );
  return {
    ...actual,
    prisma: proxy,
    $replica: proxy,
    $transaction: (client: PrismaClient, nameOrFn: unknown, fnOrOptions?: unknown) =>
      client.$transaction((typeof nameOrFn === "string" ? fnOrOptions : nameOrFn) as never),
  };
});

import { postgresTest } from "@internal/testcontainers";
import { VercelIntegrationRepository } from "~/models/vercelIntegration.server";
import { getSecretStore } from "~/services/secrets/secretStore.server";
import { EnvironmentVariablesRepository } from "~/v3/environmentVariables/environmentVariablesRepository.server";
import {
  action as updateVariable,
  loader as readVariable,
} from "~/routes/api.v1.projects.$projectRef.envvars.$slug.$name";
import { loader as readCapability } from "~/routes/api.v1.projects.$projectRef.envvars";
import { action as importVariables } from "~/routes/api.v1.projects.$projectRef.envvars.$slug.import";
import {
  createRuntimeEnvironment,
  createTestOrgProjectWithMember,
} from "../../../test/fixtures/environmentVariablesFixtures";

vi.setConfig({ testTimeout: 60_000 });
afterEach(() => vi.unstubAllGlobals());

function stubVercel(emptyValue: string) {
  const originalFetch = globalThis.fetch;
  const calls: string[] = [];
  let fail = false;
  const env = (id: string, key: string, value: string, type = "plain") => ({
    id,
    key,
    value,
    type,
    target: ["production"],
  });
  const project = [
    env("plain", "PLAIN", emptyValue),
    env("encrypted", "ENCRYPTED", "ciphertext", "encrypted"),
    env("collision", "COLLISION", emptyValue),
    env("ordinary", "ORDINARY", "updated"),
    env("sensitive", "SENSITIVE", "", "sensitive"),
  ];
  const shared = [
    env("shared", "SHARED", emptyValue),
    env("fallback", "COLLISION", "shared-fallback"),
    env("encrypted-fallback", "ENCRYPTED", "encrypted-shared-fallback"),
  ];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    if (url.hostname === "localhost" && url.port === "18374") return originalFetch(input, init);
    if (url.hostname !== "api.vercel.com")
      throw new Error(`Unexpected external request: ${url.origin}`);
    const method = input instanceof Request ? input.method : (init?.method ?? "GET");
    expect(method).toBe("GET");
    calls.push(url.pathname);
    if (fail)
      return Response.json(
        { error: { code: "forbidden", message: "Fixture denied" } },
        { status: 403 }
      );
    if (url.pathname === "/v1/env")
      return Response.json({ data: shared, pagination: { next: null } });
    if (/\/projects\/prj_fixture\/env$/.test(url.pathname)) return Response.json({ envs: project });
    if (/\/projects\/prj_fixture\/env\/encrypted$/.test(url.pathname))
      return Response.json(env("encrypted", "ENCRYPTED", emptyValue, "encrypted"));
    if (url.pathname === "/v1/env/shared")
      return Response.json(env("shared", "SHARED", emptyValue));
    throw new Error(`Unexpected Vercel request: ${url.pathname}`);
  });
  return {
    calls,
    deny: () => {
      fail = true;
    },
  };
}

async function fixture(prisma: PrismaClient) {
  database.client = prisma;
  const data = await createTestOrgProjectWithMember(prisma);
  const environment = await createRuntimeEnvironment(prisma, {
    projectId: data.project.id,
    organizationId: data.organization.id,
    type: "PRODUCTION",
    slug: "prod",
    apiKey: `tr_prod_${data.project.id}`,
  });
  const repository = new EnvironmentVariablesRepository(prisma, prisma);
  const read = async () =>
    Object.fromEntries(
      (await repository.getEnvironment(data.project.id, environment.id)).map((v) => [
        v.key,
        v.value,
      ])
    );
  const setFlag = (enabled: boolean) =>
    prisma.organization.update({
      where: { id: data.organization.id },
      data: { featureFlags: { allowEmptyEnvironmentVariableValues: enabled } },
    });
  return { ...data, environment, repository, read, setFlag };
}

describe("empty env rollout through production boundaries", () => {
  for (const emptyValue of ["", " \t "]) {
    postgresTest(
      `Vercel pull respects off/on/isolation/rollback for ${JSON.stringify(emptyValue)}`,
      async ({ prisma }) => {
        const operations: string[] = [];
        const observed = prisma.$extends({
          query: {
            $allModels: {
              $allOperations: async ({ model, operation, args, query }) => {
                operations.push(`${model}.${operation}`);
                return query(args);
              },
            },
          },
        }) as unknown as PrismaClient;
        const f = await fixture(observed);
        const other = await fixture(observed);
        const external = stubVercel(emptyValue);
        const tokenKey = `vercel-fixture-${f.project.id}`;
        await getSecretStore("DATABASE", { prismaClient: prisma }).setSecret(tokenKey, {
          accessToken: "fixture-only-token",
        });
        const integration = await prisma.organizationIntegration.create({
          data: {
            friendlyId: `int_${f.project.id}`,
            service: "VERCEL",
            integrationData: {},
            organization: { connect: { id: f.organization.id } },
            tokenReference: { create: { key: tokenKey } },
          },
          include: { tokenReference: true },
        });
        const pull = (projectId = f.project.id) =>
          VercelIntegrationRepository.pullEnvVarsFromVercel({
            projectId,
            vercelProjectId: "prj_fixture",
            teamId: "team_fixture",
            syncEnvVarsMapping: {},
            orgIntegration: integration,
          });
        await f.repository.create(f.project.id, {
          override: true,
          environmentIds: [f.environment.id],
          variables: [{ key: "PLAIN", value: "original" }],
          lastUpdatedBy: { type: "user", userId: f.user.id },
        });
        operations.length = 0;
        const off = await pull();
        expect(off.isOk()).toBe(true);
        if (off.isOk()) expect(off.value.errors).toEqual([]);
        expect(await f.read()).toEqual({
          PLAIN: "original",
          ENCRYPTED: "encrypted-shared-fallback",
          COLLISION: "shared-fallback",
          ORDINARY: "updated",
        });
        expect(operations.filter((op) => op === "FeatureFlag.findFirst")).toHaveLength(1);
        await f.setFlag(true);
        external.calls.length = 0;
        const on = await pull();
        expect(on.isOk()).toBe(true);
        if (on.isOk()) expect(on.value.errors).toEqual([]);
        expect(await f.read()).toEqual({
          PLAIN: emptyValue,
          ENCRYPTED: emptyValue,
          COLLISION: emptyValue,
          SHARED: emptyValue,
          ORDINARY: "updated",
        });
        expect(external.calls.filter((p) => p === "/v1/env")).toHaveLength(1);
        expect(external.calls.filter((p) => p.endsWith("/encrypted"))).toHaveLength(1);
        expect(external.calls.some((p) => p.endsWith("/shared") || p.endsWith("/sensitive"))).toBe(
          false
        );
        operations.length = 0;
        const repeat = await pull();
        expect(repeat.isOk() && repeat.value.syncedCount).toBe(0);
        expect(
          operations.filter((op) =>
            /\.(create|createMany|update|updateMany|upsert|delete|deleteMany)$/.test(op)
          )
        ).toEqual([]);
        expect(operations.filter((op) => op === "FeatureFlag.findFirst")).toHaveLength(0);
        await pull(other.project.id);
        expect(await other.read()).toEqual({
          COLLISION: "shared-fallback",
          ENCRYPTED: "encrypted-shared-fallback",
          ORDINARY: "updated",
        });
        external.deny();
        const failed = await pull();
        expect(failed.isOk() && failed.value.errors.length).toBeGreaterThan(0);
        expect((await f.read()).PLAIN).toBe(emptyValue);
        await f.setFlag(false);
        const stored = await f.read();
        expect(stored.PLAIN).toBe(emptyValue);
        const child = spawnSync(
          process.execPath,
          [
            "-e",
            'process.stdout.write(JSON.stringify({present:Object.hasOwn(process.env,"PLAIN"),empty:process.env.PLAIN===""}))',
          ],
          { env: { ...process.env, ...stored }, encoding: "utf8" }
        );
        expect(child.status).toBe(0);
        expect(JSON.parse(child.stdout)).toEqual({ present: true, empty: emptyValue === "" });
      }
    );
  }

  postgresTest(
    "REST update and billing-shaped import enforce the current organization flag",
    async ({ prisma }) => {
      const f = await fixture(prisma);
      const params = { projectRef: f.project.externalRef, slug: "prod", name: "REST_EMPTY" };
      const request = (method: string, body?: unknown) =>
        new Request("http://localhost/api/envvars", {
          method,
          headers: {
            authorization: `Bearer ${f.environment.apiKey}`,
            "content-type": "application/json",
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
      await f.repository.create(f.project.id, {
        override: true,
        environmentIds: [f.environment.id],
        variables: [{ key: "REST_EMPTY", value: "original" }],
      });
      const capability = async () => {
        const response = await readCapability({ params, context: {}, request: request("GET") });
        expect(response.status).toBe(200);
        return response.json();
      };
      expect((await capability()).allowEmptyEnvironmentVariableValues).toBe(false);
      const update = () =>
        updateVariable({ params, context: {}, request: request("PUT", { value: "" }) });
      const off = await update();
      expect(off?.status).toBe(400);
      expect((await f.read()).REST_EMPTY).toBe("original");
      const billingBody = {
        variables: { BILLING_EMPTY: "", BILLING_NORMAL: "updated" },
        override: true,
        source: { type: "integration", integration: "vercel" },
      };
      const sync = () =>
        importVariables({ params, context: {}, request: request("POST", billingBody) });
      expect((await sync()).status).toBe(200);
      expect((await f.read()).BILLING_EMPTY).toBeUndefined();
      await f.setFlag(true);
      expect((await capability()).allowEmptyEnvironmentVariableValues).toBe(true);
      expect((await update())?.status).toBe(200);
      expect((await sync()).status).toBe(200);
      const response = await readVariable({ params, context: {}, request: request("GET") });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ name: "REST_EMPTY", value: "" });
      expect((await f.read()).BILLING_EMPTY).toBe("");
      await f.setFlag(false);
      expect((await update())?.status).toBe(400);
      const rolledBack = await capability();
      expect(rolledBack.allowEmptyEnvironmentVariableValues).toBe(false);
      expect(rolledBack.variables.REST_EMPTY).toBe("");
      expect((await f.read()).REST_EMPTY).toBe("");
    }
  );
});
