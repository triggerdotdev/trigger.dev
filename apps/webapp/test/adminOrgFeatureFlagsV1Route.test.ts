// The v1 PAT route enables an org's snapshot dial with merge semantics. It must stamp the one-way
// per-org residency latch (snapshotStoreOrgEverEnabled) exactly as the v2 route does; without it the
// census keeps the org classified definitely-never-enabled and its resident runs' transitions are
// skipped. These drive the real exported action against a real Postgres and assert the stored blob.
// The guard is stubbed to a pass so the test isolates the stamp wiring (the guard has its own tests);
// only peripheral module boundaries are substituted, the database is the genuine article.
import type { PrismaClient } from "@trigger.dev/database";
import { postgresTest } from "@internal/testcontainers";
import { describe, expect, vi } from "vitest";
import { FEATURE_FLAG } from "~/v3/featureFlags";

vi.setConfig({ testTimeout: 60_000 });

const db = vi.hoisted(() => ({ client: null as unknown as PrismaClient }));

vi.mock("~/services/personalAccessToken.server", () => ({
  requireAdminApiRequest: async () => ({}),
}));

vi.mock("~/db.server", () => ({
  get prisma() {
    return db.client;
  },
  get $replica() {
    return db.client;
  },
}));

// Bypass the host/arming-latch gate so the test exercises the stamp path directly. The guard's own
// behaviour (reject without a host or before the global latch) is covered in its own tests.
vi.mock("~/v3/snapshotStoreFlagGuard.server", () => ({
  snapshotStoreFlagSaveError: () => undefined,
}));

vi.mock("~/v3/runOpsMigration/controlPlaneResolver.server", () => ({
  controlPlaneResolver: { invalidateOrganization: () => {} },
}));

// Only used to seed the mint-flip baseline; irrelevant to the residency latch under test.
vi.mock("~/v3/featureFlags.server", () => ({
  flags: async () => ({}),
}));

import { action } from "~/routes/admin.api.v1.orgs.$organizationId.feature-flags";

const MODE = FEATURE_FLAG.snapshotStoreOrgMode;
const LATCH = FEATURE_FLAG.snapshotStoreOrgEverEnabled;

let orgSeq = 0;

async function seedOrg(prisma: PrismaClient, featureFlags?: Record<string, unknown>) {
  db.client = prisma;
  // The save path maintains the global cohort dial map, whose row the backfill migration guarantees
  // in prod. Seed it here so the route's atomic UPDATE finds it (its own test covers the guard).
  await prisma.featureFlag.upsert({
    where: { key: FEATURE_FLAG.snapshotStoreOrgDials },
    create: { key: FEATURE_FLAG.snapshotStoreOrgDials, value: {} },
    update: {},
  });
  const id = `org_v1route_${orgSeq++}`;
  await prisma.organization.create({
    data: {
      id,
      title: "V1 route test org",
      slug: `v1-route-${id}`,
      ...(featureFlags ? { featureFlags } : {}),
    },
  });
  return id;
}

async function post(organizationId: string, body: unknown) {
  const request = new Request(
    `https://localhost:3030/admin/api/v1/orgs/${organizationId}/feature-flags`,
    {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
    }
  );
  return (await (action as any)({
    request,
    params: { organizationId },
    context: {},
  })) as Response;
}

async function readFlags(prisma: PrismaClient, id: string) {
  const row = await prisma.organization.findFirst({
    where: { id },
    select: { featureFlags: true },
  });
  return (row?.featureFlags ?? null) as Record<string, unknown> | null;
}

describe("admin v1 org feature-flags route stamps the per-org residency latch", () => {
  postgresTest("stamps the latch when the dial is enabled past off", async ({ prisma }) => {
    const id = await seedOrg(prisma);

    const response = await post(id, { [MODE]: "redis-read" });

    expect(response.status).toBe(200);
    const flags = await readFlags(prisma, id);
    expect(flags?.[MODE]).toBe("redis-read");
    expect(flags?.[LATCH]).toBe(true);
  });

  postgresTest(
    "keeps the latch when a later save sets the dial back to off",
    async ({ prisma }) => {
      const id = await seedOrg(prisma);

      await post(id, { [MODE]: "redis-read" });
      const response = await post(id, { [MODE]: "off" });

      expect(response.status).toBe(200);
      const flags = await readFlags(prisma, id);
      expect(flags?.[MODE]).toBe("off");
      // One-way: the latch survives the roll-back so a run still resident keeps mirroring.
      expect(flags?.[LATCH]).toBe(true);
    }
  );

  postgresTest(
    "does not stamp the latch for an off save with no prior latch",
    async ({ prisma }) => {
      const id = await seedOrg(prisma);

      const response = await post(id, { [MODE]: "off" });

      expect(response.status).toBe(200);
      const flags = await readFlags(prisma, id);
      expect(flags?.[LATCH]).toBeUndefined();
    }
  );
});
