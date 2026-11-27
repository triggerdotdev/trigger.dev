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

const STAMPED = {
  runOpsMintKind: "runOpsId",
  runOpsMintKindPrev: "cuid",
  runOpsMintKindFlippedAt: "2026-01-01T00:00:00.000Z",
};

const SWITCH_STAMP_ON = {
  runResidencyEnabledPrev: true,
  runResidencyEnabledFlippedAt: "2026-01-01T00:00:00.000Z",
};

async function seedGlobalFlags(prisma: PrismaClient, values: Record<string, unknown>) {
  for (const [key, value] of Object.entries(values)) {
    await prisma.featureFlag.create({ data: { key, value: value as any } });
  }
}

async function dbNowMs(prisma: PrismaClient) {
  const [{ now }] = await prisma.$queryRaw<{ now: Date }[]>`SELECT now() AS now`;
  return now.getTime();
}

// Runs the route with the process clock in 2001 and returns the database clock around it, so a
// stored change time between the two came from the database.
async function withProcessClockIn2001(prisma: PrismaClient, call: () => Promise<unknown>) {
  const before = await dbNowMs(prisma);
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2001-01-01T00:00:00.000Z"));
  try {
    await call();
  } finally {
    vi.useRealTimers();
  }
  return { before, after: await dbNowMs(prisma) };
}

async function expectSwitchStampFromDbClock(
  prisma: PrismaClient,
  orgId: string,
  clock: { before: number; after: number }
) {
  const stored = (await storedFlags(prisma, orgId)) as Record<string, unknown>;
  expect(stored.runResidencyEnabled).toBe(true);
  expect(stored.runResidencyEnabledPrev).toBe(false);
  const flippedAtMs = Date.parse(stored.runResidencyEnabledFlippedAt as string);
  expect(flippedAtMs).toBeGreaterThanOrEqual(clock.before);
  expect(flippedAtMs).toBeLessThanOrEqual(clock.after);
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

  // Catches: the v2 route storing a mint grace stamp the caller sent instead of computing it.
  postgresTest("does not store a body-supplied mint grace stamp", async ({ prisma }) => {
    const orgId = await seedOrg(prisma, { hasLogsPageAccess: true });

    const res = await callV2Action(orgId, {
      hasLogsPageAccess: true,
      runOpsMintKindPrev: "runOpsId",
      runOpsMintKindFlippedAt: "2026-01-01T00:00:00.000Z",
    });

    expect(res.status).toBe(200);
    expect(await storedFlags(prisma, orgId)).toEqual({ hasLogsPageAccess: true });
  });

  // Catches: a v2 save that resends the same mint kind re-stamping or dropping the grace stamp.
  postgresTest("a save with the same runOpsMintKind keeps the stamps", async ({ prisma }) => {
    const orgId = await seedOrg(prisma, STAMPED);

    await callV2Action(orgId, { runOpsMintKind: "runOpsId", hasQueryAccess: true });

    expect(await storedFlags(prisma, orgId)).toEqual({ ...STAMPED, hasQueryAccess: true });
  });

  // Catches: a v2 save that removes runOpsMintKind but leaves its grace stamp behind.
  postgresTest(
    "a save without runOpsMintKind removes the kind and both stamps",
    async ({ prisma }) => {
      const orgId = await seedOrg(prisma, { ...STAMPED, hasQueryAccess: true });

      await callV2Action(orgId, { hasQueryAccess: true });

      expect(await storedFlags(prisma, orgId)).toEqual({ hasQueryAccess: true });
    }
  );

  // Catches: a v2 switch change stamped from the process clock, or not stamped.
  postgresTest(
    "a runResidencyEnabled change is grace-stamped from the database clock",
    async ({ prisma }) => {
      const orgId = await seedOrg(prisma, { runResidencyEnabled: false });

      const clock = await withProcessClockIn2001(prisma, () =>
        callV2Action(orgId, { runResidencyEnabled: true })
      );

      await expectSwitchStampFromDbClock(prisma, orgId, clock);
    }
  );

  // Catches: the v2 route storing a switch stamp the caller sent instead of computing it.
  postgresTest("does not store a body-supplied switch grace stamp", async ({ prisma }) => {
    const orgId = await seedOrg(prisma, { hasLogsPageAccess: true });

    const res = await callV2Action(orgId, { hasLogsPageAccess: true, ...SWITCH_STAMP_ON });

    expect(res.status).toBe(200);
    expect(await storedFlags(prisma, orgId)).toEqual({ hasLogsPageAccess: true });
  });

  // Catches: removing an on switch without a stamp recording on (a merge-style removal).
  postgresTest(
    "removing an on switch stores no switch and a stamp recording on",
    async ({ prisma }) => {
      const orgId = await seedOrg(prisma, { runResidencyEnabled: true, hasQueryAccess: true });

      await callV2Action(orgId, { hasQueryAccess: true });

      const stored = (await storedFlags(prisma, orgId)) as Record<string, unknown>;
      expect(stored).not.toHaveProperty("runResidencyEnabled");
      expect(stored.runResidencyEnabledPrev).toBe(true);
      expect(Date.parse(stored.runResidencyEnabledFlippedAt as string)).toBeGreaterThan(
        Date.now() - 60_000
      );
    }
  );

  // Catches: a save that leaves the switch unset dropping the organisation's stamp.
  postgresTest(
    "a save that leaves the switch unset carries the organisation's stamp",
    async ({ prisma }) => {
      const orgId = await seedOrg(prisma, { ...SWITCH_STAMP_ON, hasQueryAccess: true });

      await callV2Action(orgId, { hasQueryAccess: false });

      expect(await storedFlags(prisma, orgId)).toEqual({
        ...SWITCH_STAMP_ON,
        hasQueryAccess: false,
      });
    }
  );

  // Catches: an override of off equal to the global value replacing the stamp that records on.
  postgresTest(
    "an override of off equal to the global value keeps a stamp recording on",
    async ({ prisma }) => {
      const orgId = await seedOrg(prisma, SWITCH_STAMP_ON);
      await seedGlobalFlags(prisma, { runResidencyEnabled: false });

      await callV2Action(orgId, { runResidencyEnabled: false });

      expect(await storedFlags(prisma, orgId)).toEqual({
        runResidencyEnabled: false,
        ...SWITCH_STAMP_ON,
      });
    }
  );

  // Catches: a change to off inside the grace of a change to on recording off.
  postgresTest(
    "a change from on to off inside the grace of a change to on records on",
    async ({ prisma }) => {
      const flippedAt = new Date().toISOString();
      const orgId = await seedOrg(prisma, {
        runResidencyEnabled: true,
        runResidencyEnabledPrev: false,
        runResidencyEnabledFlippedAt: flippedAt,
      });

      await callV2Action(orgId, { runResidencyEnabled: false });

      const stored = (await storedFlags(prisma, orgId)) as Record<string, unknown>;
      expect(stored.runResidencyEnabled).toBe(false);
      expect(stored.runResidencyEnabledPrev).toBe(true);
      expect(stored.runResidencyEnabledFlippedAt).not.toBe(flippedAt);
    }
  );

  // Catches: a save of another flag writing a switch key for an organisation that has none.
  postgresTest(
    "a save of another flag stores no switch key for an org with no switch",
    async ({ prisma }) => {
      const orgId = await seedOrg(prisma, { hasQueryAccess: true });
      await seedGlobalFlags(prisma, {
        runResidencyEnabled: true,
        runResidencyEnabledPrev: false,
        runResidencyEnabledFlippedAt: "2026-01-01T00:00:00.000Z",
      });

      await callV2Action(orgId, { hasQueryAccess: false, hasLogsPageAccess: true });

      expect(await storedFlags(prisma, orgId)).toEqual({
        hasQueryAccess: false,
        hasLogsPageAccess: true,
      });
    }
  );

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

  // Catches: a v1 mint kind change that is not grace-stamped.
  postgresTest("a runOpsMintKind change is grace-stamped", async ({ prisma }) => {
    const orgId = await seedOrg(prisma, { runOpsMintKind: "cuid" });

    await callV1(v1Action, orgId, { runOpsMintKind: "runOpsId" });

    const stored = (await storedFlags(prisma, orgId)) as Record<string, unknown>;
    expect(stored.runOpsMintKind).toBe("runOpsId");
    expect(stored.runOpsMintKindPrev).toBe("cuid");
    expect(typeof stored.runOpsMintKindFlippedAt).toBe("string");
  });

  // Catches: the v1 route storing a mint grace stamp the caller sent instead of computing it.
  postgresTest("does not store a body-supplied mint grace stamp", async ({ prisma }) => {
    const orgId = await seedOrg(prisma, { hasLogsPageAccess: true });

    const res = await callV1(v1Action, orgId, {
      runOpsMintKindPrev: "runOpsId",
      runOpsMintKindFlippedAt: "2026-01-01T00:00:00.000Z",
    });

    expect(res.status).toBe(200);
    expect(await storedFlags(prisma, orgId)).toEqual({ hasLogsPageAccess: true });
  });

  // Catches: a v1 save that resends the same mint kind re-stamping or dropping the grace stamp.
  postgresTest("a save with the same runOpsMintKind keeps the stamps", async ({ prisma }) => {
    const orgId = await seedOrg(prisma, STAMPED);

    await callV1(v1Action, orgId, { runOpsMintKind: "runOpsId" });

    expect(await storedFlags(prisma, orgId)).toEqual(STAMPED);
  });
  // Catches: a v1 switch change stamped from the process clock, or not stamped.
  postgresTest(
    "a runResidencyEnabled change is grace-stamped from the database clock",
    async ({ prisma }) => {
      const orgId = await seedOrg(prisma, { runResidencyEnabled: false });

      const clock = await withProcessClockIn2001(prisma, () =>
        callV1(v1Action, orgId, { runResidencyEnabled: true })
      );

      await expectSwitchStampFromDbClock(prisma, orgId, clock);
    }
  );

  // Catches: the v1 route storing a switch stamp the caller sent instead of computing it.
  postgresTest("does not store a body-supplied switch grace stamp", async ({ prisma }) => {
    const orgId = await seedOrg(prisma, { hasLogsPageAccess: true });

    const res = await callV1(v1Action, orgId, SWITCH_STAMP_ON);

    expect(res.status).toBe(200);
    expect(await storedFlags(prisma, orgId)).toEqual({ hasLogsPageAccess: true });
  });

  // Catches: an override of off equal to the global value replacing the stamp that records on.
  postgresTest(
    "an override of off equal to the global value keeps a stamp recording on",
    async ({ prisma }) => {
      const orgId = await seedOrg(prisma, SWITCH_STAMP_ON);
      await seedGlobalFlags(prisma, { runResidencyEnabled: false });

      await callV1(v1Action, orgId, { runResidencyEnabled: false });

      expect(await storedFlags(prisma, orgId)).toEqual({
        runResidencyEnabled: false,
        ...SWITCH_STAMP_ON,
      });
    }
  );

  // Catches: v1 stamping against the global flags as the own record, so a resave of an on switch reads as a change.
  postgresTest(
    "a resave of an on switch with the global off stores no stamp",
    async ({ prisma }) => {
      const orgId = await seedOrg(prisma, { runResidencyEnabled: true });
      await seedGlobalFlags(prisma, { runResidencyEnabled: false });

      const res = await callV1(v1Action, orgId, { runResidencyEnabled: true });

      expect(res.status).toBe(200);
      expect(await storedFlags(prisma, orgId)).toEqual({ runResidencyEnabled: true });
    }
  );

  // Catches: a merge save of another flag re-stamping or dropping the stored switch stamp.
  postgresTest("a save of another flag keeps the switch and its stamps", async ({ prisma }) => {
    const seeded = { runResidencyEnabled: false, ...SWITCH_STAMP_ON };
    const orgId = await seedOrg(prisma, seeded);

    await callV1(v1Action, orgId, { hasQueryAccess: true });

    expect(await storedFlags(prisma, orgId)).toEqual({ ...seeded, hasQueryAccess: true });
  });

  // Catches: a save of another flag writing a switch key for an organisation that has none.
  postgresTest(
    "a save of another flag stores no switch key for an org with no switch",
    async ({ prisma }) => {
      const orgId = await seedOrg(prisma, { hasLogsPageAccess: true });
      await seedGlobalFlags(prisma, {
        runResidencyEnabled: true,
        runResidencyEnabledPrev: false,
        runResidencyEnabledFlippedAt: "2026-01-01T00:00:00.000Z",
      });

      await callV1(v1Action, orgId, { hasQueryAccess: true });

      expect(await storedFlags(prisma, orgId)).toEqual({
        hasLogsPageAccess: true,
        hasQueryAccess: true,
      });
    }
  );
});
