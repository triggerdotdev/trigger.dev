// The page posts only the flags its UI manages, so how the action reads an absent key is the whole
// bug surface. These drive the real exported action against a real Postgres and assert on the rows
// it leaves behind. The only module substituted is the auth wrapper, so the handler can be called
// without a super-admin session; the database is the genuine article, injected into db.server.
import { boundedIn, $transaction as realTransaction } from "@trigger.dev/database";
import type { PrismaClient } from "@trigger.dev/database";
import { postgresTest } from "@internal/testcontainers";
import { describe, expect, vi } from "vitest";
import { FEATURE_FLAG } from "~/v3/featureFlags";

vi.setConfig({ testTimeout: 60_000 });

const db = vi.hoisted(() => ({ client: null as unknown as PrismaClient }));

vi.mock("~/services/routeBuilders/dashboardBuilder", () => ({
  dashboardAction: (_options: unknown, handler: unknown) => handler,
  dashboardLoader: (_options: unknown, handler: unknown) => handler,
}));

vi.mock("~/db.server", () => ({
  get prisma() {
    return db.client;
  },
  boundedIn,
  // Delegates to the SAME shared implementation the production helper wraps, so the
  // transactional semantics, the nesting case and the retry behaviour are the real ones rather
  // than a reimplementation. Only the webapp wrapper's tracing span and its infrastructure-error
  // logging are absent, and neither is asserted here.
  $transaction: (
    client: PrismaClient,
    nameOrFn: unknown,
    fnOrOptions?: unknown,
    options?: unknown
  ) => {
    const fn = (typeof nameOrFn === "function" ? nameOrFn : fnOrOptions) as Parameters<
      typeof realTransaction
    >[1];
    const opts = (typeof nameOrFn === "function" ? fnOrOptions : options) as Parameters<
      typeof realTransaction
    >[3];
    return realTransaction(client, fn, () => {}, opts);
  },
}));

import { action } from "~/routes/admin.feature-flags";

const WORKER_GROUP_ID = "clwg000000000000000000000";

async function post(host: string, body: unknown) {
  const request = new Request(`https://${host}/admin/feature-flags`, {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
  return (await (action as any)({ request, params: {}, context: {} })) as Response;
}

async function readFlag(prisma: PrismaClient, key: string) {
  const row = await prisma.featureFlag.findFirst({ where: { key }, select: { value: true } });
  return row?.value;
}

async function seed(prisma: PrismaClient) {
  db.client = prisma;
  await prisma.featureFlag.createMany({
    data: [
      { id: "ff_locked", key: FEATURE_FLAG.defaultWorkerInstanceGroupId, value: WORKER_GROUP_ID },
      { id: "ff_plain", key: FEATURE_FLAG.mollifierEnabled, value: true },
    ],
  });
}

describe("admin feature flags action", () => {
  postgresTest("keeps the locked flag when the page did not unlock it", async ({ prisma }) => {
    await seed(prisma);

    const response = await post("localhost:3030", { flags: {} });

    expect(response.status).toBe(200);
    expect(await readFlag(prisma, FEATURE_FLAG.defaultWorkerInstanceGroupId)).toBe(WORKER_GROUP_ID);
    expect(await readFlag(prisma, FEATURE_FLAG.mollifierEnabled)).toBeUndefined();
  });

  postgresTest("keeps the locked flag when the body omits the unlock field", async ({ prisma }) => {
    await seed(prisma);

    // A tab opened before the field existed posts the old shape.
    const response = await post("localhost:3030", { flags: {}, unlockLockedFlags: undefined });

    expect(response.status).toBe(200);
    expect(await readFlag(prisma, FEATURE_FLAG.defaultWorkerInstanceGroupId)).toBe(WORKER_GROUP_ID);
  });

  postgresTest("deletes the locked flag when the page unlocked it", async ({ prisma }) => {
    await seed(prisma);

    await post("localhost:3030", { flags: {}, unlockLockedFlags: true });

    expect(await readFlag(prisma, FEATURE_FLAG.defaultWorkerInstanceGroupId)).toBeUndefined();
  });

  postgresTest(
    "keeps the locked flag on managed cloud despite the unlock claim",
    async ({ prisma }) => {
      await seed(prisma);

      await post("cloud.trigger.dev", { flags: {}, unlockLockedFlags: true });

      expect(await readFlag(prisma, FEATURE_FLAG.defaultWorkerInstanceGroupId)).toBe(
        WORKER_GROUP_ID
      );
    }
  );

  postgresTest(
    "rejects a locked flag submitted to managed cloud, writing nothing",
    async ({ prisma }) => {
      await seed(prisma);

      const response = await post("cloud.trigger.dev", {
        flags: { [FEATURE_FLAG.defaultWorkerInstanceGroupId]: "clwg999" },
      });

      expect(response.status).toBe(400);
      expect(await readFlag(prisma, FEATURE_FLAG.defaultWorkerInstanceGroupId)).toBe(
        WORKER_GROUP_ID
      );
      expect(await readFlag(prisma, FEATURE_FLAG.mollifierEnabled)).toBe(true);
    }
  );

  postgresTest("rejects a value the catalog refuses, writing nothing", async ({ prisma }) => {
    await seed(prisma);

    const response = await post("localhost:3030", {
      flags: { [FEATURE_FLAG.realtimeBackend]: "not-a-backend" },
    });

    expect(response.status).toBe(400);
    expect(await readFlag(prisma, FEATURE_FLAG.mollifierEnabled)).toBe(true);
  });

  postgresTest("upserts what was submitted and sweeps what was not", async ({ prisma }) => {
    await seed(prisma);

    await post("localhost:3030", {
      flags: { [FEATURE_FLAG.hasAiAccess]: true },
      unlockLockedFlags: false,
    });

    expect(await readFlag(prisma, FEATURE_FLAG.hasAiAccess)).toBe(true);
    expect(await readFlag(prisma, FEATURE_FLAG.mollifierEnabled)).toBeUndefined();
    expect(await readFlag(prisma, FEATURE_FLAG.defaultWorkerInstanceGroupId)).toBe(WORKER_GROUP_ID);
  });
});
