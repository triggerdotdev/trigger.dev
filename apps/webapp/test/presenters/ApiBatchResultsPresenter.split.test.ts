// Run-ops split resolution LOCK for ApiBatchResultsPresenter.
//
// GET /api/v1/batches/:id/results constructs the presenter BARE (no injected client), so it must
// resolve a batch that lives in the NEW run-ops DB on its own. The presenter routes the batch-row
// lookup through the `runStore` singleton, whose split router probes NEW→LEGACY. This drives a
// NEW-resident (ksuid) batch through a REAL two-physical-DB split router and asserts the bare
// presenter finds it. Fails before the fix (the presenter read the control-plane DB directly and
// 404'd on a NEW-resident batch).

import { heteroRunOpsPostgresTest } from "@internal/testcontainers";
import { PostgresRunStore, RoutingRunStore } from "@internal/run-store";
import type { RunOpsPrismaClient } from "@internal/run-ops-database";
import type { Organization, PrismaClient, Project } from "@trigger.dev/database";
import { generateKsuidId } from "@trigger.dev/core/v3/isomorphic";
import { expect, vi } from "vitest";
import { ApiBatchResultsPresenter } from "~/presenters/v3/ApiBatchResultsPresenter.server";
import type { AuthenticatedEnvironment } from "~/services/apiAuth.server";

// The split router built over the two testcontainer DBs; injected in place of the db.server-backed
// singleton the presenter imports. Populated per-test before the presenter is constructed.
let testRunStore: RoutingRunStore;

// Presenter reads the batch row via `runStore`; child-run reads also go through it. Neutralize the
// real db.server singleton (no env DB) and the runStore singleton (use the split router below).
// The getter defers to `testRunStore` so each test can set its own router before constructing.
vi.mock("~/db.server", () => ({ prisma: {}, $replica: {} }));
vi.mock("~/v3/runStore.server", () => ({
  get runStore() {
    return testRunStore;
  },
}));

vi.setConfig({ testTimeout: 60_000 });

function makeSplitRouter(prisma14: PrismaClient, prisma17: RunOpsPrismaClient) {
  const legacyStore = new PostgresRunStore({
    prisma: prisma14,
    readOnlyPrisma: prisma14,
    schemaVariant: "legacy",
  });
  const newStore = new PostgresRunStore({
    prisma: prisma17 as never,
    readOnlyPrisma: prisma17 as never,
    schemaVariant: "dedicated",
  });
  return new RoutingRunStore({ new: newStore, legacy: legacyStore });
}

function authEnv(environmentId: string): AuthenticatedEnvironment {
  return {
    id: environmentId,
    type: "DEVELOPMENT",
    project: { id: "proj_split" } as Project,
    organization: { id: "org_split" } as Organization,
    orgMember: null,
  } as unknown as AuthenticatedEnvironment;
}

heteroRunOpsPostgresTest(
  "a bare ApiBatchResultsPresenter resolves a NEW-resident (ksuid) batch under the split",
  async ({ prisma14, prisma17 }) => {
    testRunStore = makeSplitRouter(prisma14, prisma17);

    const environmentId = "env_split_res";
    // ksuid internal id → classifies to the NEW store, seeded in the NEW (prisma17) DB. The
    // friendlyId probe fans out NEW→LEGACY regardless of id shape, so the NEW seed is what matters.
    const batchInternalId = generateKsuidId();
    const batchFriendlyId = `batch_${generateKsuidId()}`;

    await prisma17.batchTaskRun.create({
      data: {
        id: batchInternalId,
        friendlyId: batchFriendlyId,
        runtimeEnvironmentId: environmentId,
      },
    });

    // Bare construction — exactly how the results route builds it.
    const presenter = new ApiBatchResultsPresenter();
    const result = await presenter.call(batchFriendlyId, authEnv(environmentId));

    // Before the fix this 404s (undefined) because a control-plane read misses the NEW-resident batch.
    expect(result).toEqual({ id: batchFriendlyId, items: [] });
  }
);

heteroRunOpsPostgresTest(
  "a bare ApiBatchResultsPresenter still returns undefined for a genuinely missing batch",
  async ({ prisma14, prisma17 }) => {
    testRunStore = makeSplitRouter(prisma14, prisma17);

    const presenter = new ApiBatchResultsPresenter();
    const result = await presenter.call("batch_does_not_exist", authEnv("env_none"));

    expect(result).toBeUndefined();
  }
);
