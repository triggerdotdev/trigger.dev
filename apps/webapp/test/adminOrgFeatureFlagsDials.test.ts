// The admin org-flag save path maintains the global snapshotStoreOrgDials cohort map with a single
// atomic jsonb_set: enabling an org records its dial, a later save to off keeps the entry (never a
// deletion), concurrent saves for different orgs do not clobber each other, and a missing flag row
// trips the zero-rows guard. Drives the real exported v1 action against a real Postgres and asserts
// the stored FeatureFlag row. Only peripheral module boundaries are substituted; the DB is genuine.
import { PrismaClient } from "@trigger.dev/database";
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

// Bypass the host/arming-latch gate so the test isolates the map maintenance. The guard's own
// behaviour is covered in its own tests.
vi.mock("~/v3/snapshotStoreFlagGuard.server", () => ({
  snapshotStoreFlagSaveError: () => undefined,
}));

vi.mock("~/v3/runOpsMigration/controlPlaneResolver.server", () => ({
  controlPlaneResolver: { invalidateOrganization: () => {} },
}));

// Only used to seed the mint-flip baseline and back the global registry reload; irrelevant here.
vi.mock("~/v3/featureFlags.server", () => ({
  flags: async () => ({}),
}));

import { action } from "~/routes/admin.api.v1.orgs.$organizationId.feature-flags";

const MODE = FEATURE_FLAG.snapshotStoreOrgMode;
const DIALS = FEATURE_FLAG.snapshotStoreOrgDials;
// An org flag unrelated to the snapshot dial, used to prove an ordinary save never enrolls an org.
const UNRELATED = FEATURE_FLAG.hasAiAccess;

let orgSeq = 0;

async function seedOrg(prisma: PrismaClient) {
  db.client = prisma;
  const id = `org_dials_${orgSeq++}`;
  await prisma.organization.create({
    data: {
      id,
      title: "Dials route test org",
      slug: `dials-route-${id}`,
    },
  });
  return id;
}

async function seedDialsRow(prisma: PrismaClient) {
  await prisma.featureFlag.upsert({
    where: { key: DIALS },
    create: { key: DIALS, value: {} },
    update: { value: {} },
  });
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

async function readDials(prisma: PrismaClient) {
  const row = await prisma.featureFlag.findFirst({
    where: { key: DIALS },
    select: { value: true },
  });
  return (row?.value ?? null) as Record<string, unknown> | null;
}

describe("admin org feature-flags route maintains the snapshotStoreOrgDials cohort map", () => {
  postgresTest("enabling an org records its dial in the map", async ({ prisma }) => {
    await seedDialsRow(prisma);
    const id = await seedOrg(prisma);

    const response = await post(id, { [MODE]: "redis-read" });

    expect(response.status).toBe(200);
    const dials = await readDials(prisma);
    expect(dials?.[id]).toBe("redis-read");
  });

  postgresTest(
    "an unrelated save on a never-enrolled org leaves it out of the map",
    async ({ prisma }) => {
      await seedDialsRow(prisma);
      const id = await seedOrg(prisma);

      // No snapshotStoreOrgMode: the one-way latch is never stamped, so the org is not enrolled and
      // must NOT be auto-written as "off" (which the resolver would read as an opt-out beating the
      // global dial, pinning the org off the fleet rollout).
      const response = await post(id, { [UNRELATED]: true });

      expect(response.status).toBe(200);
      const dials = await readDials(prisma);
      expect(Object.hasOwn(dials ?? {}, id)).toBe(false);
      expect(dials?.[id]).toBeUndefined();
    }
  );

  postgresTest(
    "an unrelated save on an already-enrolled org maintains its entry",
    async ({ prisma }) => {
      await seedDialsRow(prisma);
      const id = await seedOrg(prisma);

      // Enroll first (stamps the latch), then a later unrelated save keeps the entry at its dial.
      await post(id, { [MODE]: "redis-read" });
      const response = await post(id, { [UNRELATED]: true });

      expect(response.status).toBe(200);
      const dials = await readDials(prisma);
      expect(dials?.[id]).toBe("redis-read");
    }
  );

  postgresTest("a later save to off stores off and keeps the entry present", async ({ prisma }) => {
    await seedDialsRow(prisma);
    const id = await seedOrg(prisma);

    await post(id, { [MODE]: "redis-read" });
    const response = await post(id, { [MODE]: "off" });

    expect(response.status).toBe(200);
    const dials = await readDials(prisma);
    // Never deleted: off is a stored value, so the key survives the roll-back.
    expect(dials).not.toBeNull();
    expect(Object.hasOwn(dials, id)).toBe(true);
    expect(dials?.[id]).toBe("off");
  });

  postgresTest("saves for different orgs both persist without clobbering", async ({ prisma }) => {
    await seedDialsRow(prisma);
    const orgA = await seedOrg(prisma);
    const orgB = await seedOrg(prisma);

    await post(orgA, { [MODE]: "dual-write" });
    await post(orgB, { [MODE]: "redis-only" });

    const dials = await readDials(prisma);
    expect(dials?.[orgA]).toBe("dual-write");
    expect(dials?.[orgB]).toBe("redis-only");
  });

  // The atomicity invariant the design rests on, which the sequential test above cannot see (a
  // read-modify-write regression passes a sequential save identically). Two independent clients
  // overlap on the same map row: client 1 writes org A and holds its transaction open, client 2
  // then writes org B (blocking on the row lock), client 1 commits, client 2 unblocks and merges
  // onto the committed value. A read-modify-write regression would clobber org A here.
  postgresTest(
    "overlapping transactions on the same map row both survive (atomic merge under contention)",
    async ({ prisma, postgresContainer }) => {
      await seedDialsRow(prisma);
      const orgA = `org_concurrent_a_${orgSeq++}`;
      const orgB = `org_concurrent_b_${orgSeq++}`;

      const url = postgresContainer.getConnectionUri();
      const client1 = new PrismaClient({ datasources: { db: { url } } });
      const client2 = new PrismaClient({ datasources: { db: { url } } });

      // The exact maintenance statement the routes run, keyed by org and dial.
      const maintain = (tx: PrismaClient, orgId: string, dial: string) => tx.$executeRaw`
        UPDATE "FeatureFlag"
        SET "value" = jsonb_set(COALESCE("value", '{}'::jsonb), ARRAY[${orgId}], to_jsonb(${dial}::text)),
            "updatedAt" = now()
        WHERE "key" = ${DIALS}`;

      const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

      let signalAHolding: () => void;
      const aHolding = new Promise<void>((resolve) => (signalAHolding = resolve));
      let signalBIssued: () => void;
      const bIssued = new Promise<void>((resolve) => (signalBIssued = resolve));

      try {
        const p1 = client1.$transaction(
          async (tx) => {
            await maintain(tx as unknown as PrismaClient, orgA, "redis-read");
            // Row lock now held by this open transaction.
            signalAHolding();
            // Wait until client 2 has fired its (blocking) write, then hold a beat so it reaches the
            // lock wait, before committing.
            await bIssued;
            await sleep(300);
          },
          { timeout: 20_000 }
        );

        const p2 = client2.$transaction(
          async (tx) => {
            await aHolding;
            // Fire the write without awaiting: it blocks on client 1's row lock until the commit.
            const writeB = maintain(tx as unknown as PrismaClient, orgB, "redis-only");
            signalBIssued();
            await writeB;
          },
          { timeout: 20_000 }
        );

        await Promise.all([p1, p2]);
      } finally {
        await client1.$disconnect();
        await client2.$disconnect();
      }

      const dials = await readDials(prisma);
      expect(dials?.[orgA]).toBe("redis-read");
      expect(dials?.[orgB]).toBe("redis-only");
    }
  );

  postgresTest("throws when the flag row is absent (zero-rows guard)", async ({ prisma }) => {
    // Deliberately do NOT seed the dials row.
    db.client = prisma;
    await prisma.featureFlag.deleteMany({ where: { key: DIALS } });
    const id = await seedOrg(prisma);

    const response = await post(id, { [MODE]: "redis-read" });

    expect(response.status).toBe(400);
    const bodyJson = (await response.json()) as { error?: string };
    expect(bodyJson.error).toContain("snapshotStoreOrgDials flag row missing");
  });
});
