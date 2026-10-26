// Drives the real org feature-flag admin routes against a real Postgres and asserts on the stored
// Organization.featureFlags. Only auth and the control-plane cache invalidation are substituted.
import type { PrismaClient } from "@trigger.dev/database";
import { postgresTest } from "@internal/testcontainers";
import { describe, expect, vi } from "vitest";

vi.setConfig({ testTimeout: 60_000 });

const db = vi.hoisted(() => ({ client: null as unknown as PrismaClient }));

vi.mock("~/db.server", async () => {
  const { boundedIn } = await import("@trigger.dev/database");
  // Forwards every access to the current test's client, so module-level singletons built at
  // import time (e.g. the global flags reader) still reach it.
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

vi.mock("~/services/session.server", () => ({
  requireUser: async () => ({ id: "user_admin", admin: true }),
}));

vi.mock("~/services/personalAccessToken.server", () => ({
  requireAdminApiRequest: async () => ({ id: "user_admin", admin: true }),
}));

vi.mock("~/v3/runOpsMigration/controlPlaneResolver.server", () => ({
  controlPlaneResolver: { invalidateOrganization: () => {} },
}));

import {
  action as v1Action,
  loader as v1Loader,
} from "~/routes/admin.api.v1.orgs.$organizationId.feature-flags";
import {
  action as v2Action,
  loader as v2Loader,
} from "~/routes/admin.api.v2.orgs.$organizationId.feature-flags";

async function seedOrg(prisma: PrismaClient, featureFlags: unknown) {
  db.client = prisma;
  const org = await prisma.organization.create({
    data: { title: "Flags org", slug: `flags-${Math.random().toString(36).slice(2, 10)}` },
  });
  if (featureFlags !== undefined) {
    await prisma.organization.update({
      where: { id: org.id },
      data: { featureFlags: featureFlags as any },
    });
  }
  return org.id;
}

async function storedFlags(prisma: PrismaClient, orgId: string) {
  const org = await prisma.organization.findFirst({
    where: { id: orgId },
    select: { featureFlags: true },
  });
  return org?.featureFlags;
}

function request(path: string, body?: unknown) {
  return new Request(`https://test.trigger.dev${path}`, {
    method: body === undefined ? "GET" : "POST",
    body: body === undefined ? undefined : JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

async function callV2Loader(orgId: string) {
  const res = (await (v2Loader as any)({
    request: request(`/admin/api/v2/orgs/${orgId}/feature-flags`),
    params: { organizationId: orgId },
    context: {},
  })) as Response;
  return res.json();
}

async function callV2Action(orgId: string, body: unknown) {
  return (await (v2Action as any)({
    request: request(`/admin/api/v2/orgs/${orgId}/feature-flags`, body),
    params: { organizationId: orgId },
    context: {},
  })) as Response;
}

async function callV1(handler: unknown, orgId: string, body?: unknown) {
  return (await (handler as any)({
    request: request(`/admin/api/v1/orgs/${orgId}/feature-flags`, body),
    params: { organizationId: orgId },
    context: {},
  })) as Response;
}

const MIXED = {
  hasLogsPageAccess: true,
  taskEventRepository: "clickhouse",
  realtimeBackend: "not-a-backend",
  someNewerFlag: true,
};

describe("v2 org flags loader", () => {
  postgresTest("returns valid keys and invalid values separately", async ({ prisma }) => {
    const orgId = await seedOrg(prisma, MIXED);

    const data = await callV2Loader(orgId);

    expect(data.orgFlags).toEqual({ hasLogsPageAccess: true, taskEventRepository: "clickhouse" });
    expect(data.invalidOrgFlags).toEqual({ realtimeBackend: "not-a-backend" });
    expect(JSON.stringify(data)).not.toContain("someNewerFlag");
  });
});

describe("v2 org flags action", () => {
  postgresTest(
    "keeps an invalid stored value the body sends back unchanged",
    async ({ prisma }) => {
      const orgId = await seedOrg(prisma, {
        hasLogsPageAccess: true,
        realtimeBackend: "not-a-backend",
      });

      const res = await callV2Action(orgId, {
        hasLogsPageAccess: false,
        realtimeBackend: "not-a-backend",
      });

      expect(res.status).toBe(200);
      expect(await storedFlags(prisma, orgId)).toEqual({
        hasLogsPageAccess: false,
        realtimeBackend: "not-a-backend",
      });
    }
  );

  postgresTest("removes an invalid stored value the body leaves out", async ({ prisma }) => {
    const orgId = await seedOrg(prisma, {
      hasLogsPageAccess: true,
      realtimeBackend: "not-a-backend",
    });

    await callV2Action(orgId, { hasLogsPageAccess: true });

    expect(await storedFlags(prisma, orgId)).toEqual({ hasLogsPageAccess: true });
  });

  postgresTest("rejects a new invalid value and writes nothing", async ({ prisma }) => {
    const stored = { hasLogsPageAccess: true, realtimeBackend: "not-a-backend" };
    const orgId = await seedOrg(prisma, stored);

    const res = await callV2Action(orgId, {
      hasLogsPageAccess: false,
      realtimeBackend: "still-not-a-backend",
    });

    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("realtimeBackend");
    expect(await storedFlags(prisma, orgId)).toEqual(stored);
  });

  postgresTest("rejects an unknown key the org doesn't store", async ({ prisma }) => {
    const orgId = await seedOrg(prisma, { hasLogsPageAccess: true });

    const res = await callV2Action(orgId, { notAFlag: true });

    expect(res.status).toBe(400);
    expect(await storedFlags(prisma, orgId)).toEqual({ hasLogsPageAccess: true });
  });

  postgresTest("keeps stored keys unknown to this release", async ({ prisma }) => {
    const orgId = await seedOrg(prisma, { someNewerFlag: true, hasLogsPageAccess: true });

    await callV2Action(orgId, { hasLogsPageAccess: false });

    expect(await storedFlags(prisma, orgId)).toEqual({
      someNewerFlag: true,
      hasLogsPageAccess: false,
    });
  });

  postgresTest("keeps the locked live override across an unrelated save", async ({ prisma }) => {
    const orgId = await seedOrg(prisma, { taskEventRepository: "clickhouse" });
    const { orgFlags, invalidOrgFlags } = await callV2Loader(orgId);

    // What the dialog posts after toggling one unrelated flag.
    await callV2Action(orgId, { ...orgFlags, ...invalidOrgFlags, hasQueryAccess: true });

    expect(await storedFlags(prisma, orgId)).toEqual({
      taskEventRepository: "clickhouse",
      hasQueryAccess: true,
    });
  });

  postgresTest("unsetting the locked live override removes it", async ({ prisma }) => {
    const orgId = await seedOrg(prisma, {
      taskEventRepository: "clickhouse",
      hasQueryAccess: true,
    });

    await callV2Action(orgId, { hasQueryAccess: true });

    expect(await storedFlags(prisma, orgId)).toEqual({ hasQueryAccess: true });
  });

  postgresTest("a runOpsMintKind flip is still grace-stamped", async ({ prisma }) => {
    const orgId = await seedOrg(prisma, { runOpsMintKind: "cuid" });

    await callV2Action(orgId, { runOpsMintKind: "runOpsId" });

    const stored = (await storedFlags(prisma, orgId)) as Record<string, unknown>;
    expect(stored.runOpsMintKind).toBe("runOpsId");
    expect(stored.runOpsMintKindPrev).toBe("cuid");
    expect(typeof stored.runOpsMintKindFlippedAt).toBe("string");
  });

  postgresTest("clear-all clears every known flag", async ({ prisma }) => {
    const orgId = await seedOrg(prisma, {
      hasLogsPageAccess: true,
      taskEventRepository: "clickhouse",
      realtimeBackend: "not-a-backend",
    });

    const res = await callV2Action(orgId, null);

    expect(res.status).toBe(200);
    expect(await storedFlags(prisma, orgId)).toBeNull();
  });

  postgresTest("clear-all keeps stored keys unknown to this release", async ({ prisma }) => {
    const orgId = await seedOrg(prisma, MIXED);

    const res = await callV2Action(orgId, {});

    expect(res.status).toBe(200);
    expect(await storedFlags(prisma, orgId)).toEqual({ someNewerFlag: true });
  });

  postgresTest(
    "unsetting the last visible flag in the dialog keeps hidden keys",
    async ({ prisma }) => {
      const orgId = await seedOrg(prisma, { hasQueryAccess: true, someNewerFlag: true });
      const { orgFlags, invalidOrgFlags } = await callV2Loader(orgId);
      const draft: Record<string, unknown> = { ...orgFlags, ...invalidOrgFlags };
      delete draft.hasQueryAccess;

      // What the dialog posts once nothing is left to override.
      await callV2Action(orgId, Object.keys(draft).length === 0 ? null : draft);

      expect(await storedFlags(prisma, orgId)).toEqual({ someNewerFlag: true });
    }
  );
});

describe("v1 org flags API", () => {
  postgresTest(
    "loader returns the valid keys of a blob with an invalid value",
    async ({ prisma }) => {
      const orgId = await seedOrg(prisma, MIXED);

      const data = await (await callV1(v1Loader, orgId)).json();

      expect(data.featureFlags).toEqual({
        hasLogsPageAccess: true,
        taskEventRepository: "clickhouse",
      });
    }
  );

  postgresTest("merge write keeps invalid and unknown stored values", async ({ prisma }) => {
    const orgId = await seedOrg(prisma, {
      hasLogsPageAccess: true,
      realtimeBackend: "not-a-backend",
      someNewerFlag: 1,
    });

    const res = await callV1(v1Action, orgId, { hasQueryAccess: true });

    expect(res.status).toBe(200);
    expect(await storedFlags(prisma, orgId)).toEqual({
      hasLogsPageAccess: true,
      realtimeBackend: "not-a-backend",
      someNewerFlag: 1,
      hasQueryAccess: true,
    });
    expect((await res.json()).featureFlags).toEqual({
      hasLogsPageAccess: true,
      hasQueryAccess: true,
    });
  });

  postgresTest("an invalid request body is still rejected", async ({ prisma }) => {
    const orgId = await seedOrg(prisma, { hasLogsPageAccess: true });

    const res = await callV1(v1Action, orgId, { realtimeBackend: "not-a-backend" });

    expect(res.status).toBe(400);
    expect(await storedFlags(prisma, orgId)).toEqual({ hasLogsPageAccess: true });
  });
});
