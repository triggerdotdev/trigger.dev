import { describe, expect, vi } from "vitest";

// The sessions.server module graph imports `~/db.server` (and the run-store
// singleton) at load. Stub `~/db.server` so importing the module under test does
// not construct the real boot clients — the serializer is driven entirely through
// an explicitly injected RunStore built from the real test containers.
vi.mock("~/db.server", () => ({
  prisma: {},
  $replica: {},
}));

import { heteroRunOpsPostgresTest, postgresTest } from "@internal/testcontainers";
import { buildRunStore } from "~/v3/runStore.server";
import { generateKsuidId } from "@trigger.dev/core/v3/isomorphic";
import type { RunOpsPrismaClient } from "@internal/run-ops-database";
import type { PrismaClient } from "@trigger.dev/database";
import {
  resolveSessionByIdOrExternalId,
  serializeSessionsWithFriendlyRunIds,
  serializeSessionWithFriendlyRunId,
} from "~/services/realtime/sessions.server";

vi.setConfig({ testTimeout: 90_000 });

type SeedContext = {
  organizationId: string;
  projectId: string;
  environmentId: string;
};

/**
 * Creates the org/project/env parents on the control-plane client. `Session`
 * and the legacy `TaskRun` both need these FK parents; the dedicated run-ops
 * schema (`prisma17`) is FK-free, so NEW runs only need the scalar tenant ids.
 */
async function seedParents(prisma: PrismaClient, slug: string): Promise<SeedContext> {
  const organization = await prisma.organization.create({
    data: { title: `org-${slug}`, slug: `org-${slug}` },
  });
  const project = await prisma.project.create({
    data: {
      name: `proj-${slug}`,
      slug: `proj-${slug}`,
      organizationId: organization.id,
      externalRef: `proj-${slug}`,
    },
  });
  const runtimeEnvironment = await prisma.runtimeEnvironment.create({
    data: {
      slug: `env-${slug}`,
      type: "DEVELOPMENT",
      projectId: project.id,
      organizationId: organization.id,
      apiKey: `tr_dev_${slug}`,
      pkApiKey: `pk_dev_${slug}`,
      shortcode: `sc-${slug}`,
    },
  });

  return {
    organizationId: organization.id,
    projectId: project.id,
    environmentId: runtimeEnvironment.id,
  };
}

/**
 * Create a legacy (control-plane) TaskRun. A default cuid id classifies LEGACY.
 */
async function createLegacyRun(
  prisma: PrismaClient,
  ctx: SeedContext,
  run: { friendlyId: string }
) {
  return prisma.taskRun.create({
    data: {
      friendlyId: run.friendlyId,
      taskIdentifier: "my-task",
      status: "PENDING",
      payload: JSON.stringify({ foo: run.friendlyId }),
      traceId: run.friendlyId,
      spanId: run.friendlyId,
      queue: "test",
      runtimeEnvironmentId: ctx.environmentId,
      projectId: ctx.projectId,
      organizationId: ctx.organizationId,
      environmentType: "DEVELOPMENT",
      engine: "V2",
    },
  });
}

/**
 * Create a NEW (dedicated run-ops) TaskRun with a ksuid id — classifies NEW and
 * lives only on the run-ops DB. Scalar tenant columns only (the subset schema is
 * FK-free, so no org/project/env rows are required here).
 */
async function createNewRun(
  prisma: RunOpsPrismaClient,
  ctx: SeedContext,
  run: { friendlyId: string; id: string }
) {
  return prisma.taskRun.create({
    data: {
      id: run.id,
      friendlyId: run.friendlyId,
      taskIdentifier: "my-task",
      status: "PENDING",
      payload: JSON.stringify({ foo: run.friendlyId }),
      traceId: run.friendlyId,
      spanId: run.friendlyId,
      queue: "test",
      runtimeEnvironmentId: ctx.environmentId,
      projectId: ctx.projectId,
      organizationId: ctx.organizationId,
      environmentType: "DEVELOPMENT",
      engine: "V2",
    },
  });
}

async function createSession(
  prisma: PrismaClient,
  ctx: SeedContext,
  session: { friendlyId: string; externalId?: string; currentRunId?: string | null }
) {
  return prisma.session.create({
    data: {
      friendlyId: session.friendlyId,
      externalId: session.externalId,
      type: "chat",
      projectId: ctx.projectId,
      runtimeEnvironmentId: ctx.environmentId,
      environmentType: "DEVELOPMENT",
      organizationId: ctx.organizationId,
      taskIdentifier: "my-task",
      triggerConfig: {},
      currentRunId: session.currentRunId ?? null,
    },
  });
}

describe("sessions serializer currentRunId resolution", () => {
  // --- Passthrough single-run (single-DB) ---
  postgresTest(
    "single-run passthrough resolves currentRunId -> friendlyId; null stays null",
    async ({ prisma }) => {
      const ctx = await seedParents(prisma as PrismaClient, "single-pass");
      const run = await createLegacyRun(prisma as PrismaClient, ctx, { friendlyId: "run_single" });
      const session = await createSession(prisma as PrismaClient, ctx, {
        friendlyId: "session_single",
        currentRunId: run.id,
      });
      const nullSession = await createSession(prisma as PrismaClient, ctx, {
        friendlyId: "session_null",
        currentRunId: null,
      });

      const store = buildRunStore({
        splitEnabled: false,
        singleWriter: prisma as PrismaClient,
        singleReplica: prisma as PrismaClient,
      });

      const item = await serializeSessionWithFriendlyRunId(session, store);
      expect(item.currentRunId).toBe("run_single");

      const nullItem = await serializeSessionWithFriendlyRunId(nullSession, store);
      expect(nullItem.currentRunId).toBeNull();
    }
  );

  // --- Passthrough batched (single-DB) + tenant scope ---
  postgresTest(
    "batched passthrough resolves each currentRunId; null stays null; cross-env is dropped",
    async ({ prisma }) => {
      const ctx = await seedParents(prisma as PrismaClient, "batch-pass");
      const otherCtx = await seedParents(prisma as PrismaClient, "batch-pass-other");

      const runA = await createLegacyRun(prisma as PrismaClient, ctx, { friendlyId: "run_A" });
      const runB = await createLegacyRun(prisma as PrismaClient, ctx, { friendlyId: "run_B" });
      // A run in a DIFFERENT env — pointer must not resolve under our scope.
      const crossEnvRun = await createLegacyRun(prisma as PrismaClient, otherCtx, {
        friendlyId: "run_cross",
      });

      const sessionA = await createSession(prisma as PrismaClient, ctx, {
        friendlyId: "session_A",
        currentRunId: runA.id,
      });
      const sessionB = await createSession(prisma as PrismaClient, ctx, {
        friendlyId: "session_B",
        currentRunId: runB.id,
      });
      const sessionNull = await createSession(prisma as PrismaClient, ctx, {
        friendlyId: "session_n",
        currentRunId: null,
      });
      const sessionCross = await createSession(prisma as PrismaClient, ctx, {
        friendlyId: "session_x",
        currentRunId: crossEnvRun.id,
      });

      const store = buildRunStore({
        splitEnabled: false,
        singleWriter: prisma as PrismaClient,
        singleReplica: prisma as PrismaClient,
      });

      const items = await serializeSessionsWithFriendlyRunIds(
        [sessionA, sessionB, sessionNull, sessionCross],
        { projectId: ctx.projectId, runtimeEnvironmentId: ctx.environmentId },
        store
      );

      const byFriendly = new Map(items.map((i) => [i.id, i.currentRunId]));
      expect(byFriendly.get("session_A")).toBe("run_A");
      expect(byFriendly.get("session_B")).toBe("run_B");
      expect(byFriendly.get("session_n")).toBeNull();
      // cross-env run exists, but the tenant-scoped find drops it -> null.
      expect(byFriendly.get("session_x")).toBeNull();
    }
  );

  // --- Control-plane Session resolve is not routed ---
  postgresTest(
    "resolveSessionByIdOrExternalId resolves the Session row by friendlyId and by externalId",
    async ({ prisma }) => {
      const ctx = await seedParents(prisma as PrismaClient, "controlplane");
      const session = await createSession(prisma as PrismaClient, ctx, {
        friendlyId: "session_cp",
        externalId: "ext-cp-1",
        currentRunId: null,
      });

      const byFriendly = await resolveSessionByIdOrExternalId(
        prisma as PrismaClient,
        ctx.environmentId,
        session.friendlyId
      );
      expect(byFriendly?.id).toBe(session.id);

      const byExternal = await resolveSessionByIdOrExternalId(
        prisma as PrismaClient,
        ctx.environmentId,
        "ext-cp-1"
      );
      expect(byExternal?.id).toBe(session.id);
    }
  );

  // --- Split single-run across two physical DBs (the production-shaped break) ---
  // ksuid (NEW-DB) session run must serialize a non-null friendlyId, and a cuid
  // (LEGACY) run must still resolve — proving the asymmetry is gone.
  heteroRunOpsPostgresTest(
    "split single-run resolves a NEW-ksuid run from the run-ops DB and a LEGACY-cuid run from control-plane",
    async ({ prisma14, prisma17 }) => {
      const ctx = await seedParents(prisma14, "split-single");

      const newRun = await createNewRun(prisma17, ctx, {
        friendlyId: "run_new",
        id: generateKsuidId(),
      });
      const legacyRun = await createLegacyRun(prisma14, ctx, { friendlyId: "run_legacy" });

      const newSession = await createSession(prisma14, ctx, {
        friendlyId: "session_new",
        currentRunId: newRun.id,
      });
      const legacySession = await createSession(prisma14, ctx, {
        friendlyId: "session_legacy",
        currentRunId: legacyRun.id,
      });

      const store = buildRunStore({
        splitEnabled: true,
        newWriter: prisma17,
        newReplica: prisma17,
        legacyWriter: prisma14,
        legacyReplica: prisma14,
        singleWriter: prisma14,
        singleReplica: prisma14,
      });

      const newItem = await serializeSessionWithFriendlyRunId(newSession, store);
      expect(newItem.currentRunId).toBe("run_new");

      const legacyItem = await serializeSessionWithFriendlyRunId(legacySession, store);
      expect(legacyItem.currentRunId).toBe("run_legacy");
    }
  );

  // --- Split batched — NEW + legacy union; null + cross-env dropped ---
  heteroRunOpsPostgresTest(
    "split batched resolves runs across NEW + legacy; null stays null; cross-env dropped",
    async ({ prisma14, prisma17 }) => {
      const ctx = await seedParents(prisma14, "split-batch");
      const otherCtx = await seedParents(prisma14, "split-batch-other");

      const newRun = await createNewRun(prisma17, ctx, {
        friendlyId: "run_bnew",
        id: generateKsuidId(),
      });
      const legacyRun = await createLegacyRun(prisma14, ctx, { friendlyId: "run_blegacy" });
      const crossEnvRun = await createLegacyRun(prisma14, otherCtx, { friendlyId: "run_bcross" });

      const sessionNew = await createSession(prisma14, ctx, {
        friendlyId: "session_bnew",
        currentRunId: newRun.id,
      });
      const sessionLegacy = await createSession(prisma14, ctx, {
        friendlyId: "session_blegacy",
        currentRunId: legacyRun.id,
      });
      const sessionNull = await createSession(prisma14, ctx, {
        friendlyId: "session_bnull",
        currentRunId: null,
      });
      const sessionCross = await createSession(prisma14, ctx, {
        friendlyId: "session_bcross",
        currentRunId: crossEnvRun.id,
      });

      const store = buildRunStore({
        splitEnabled: true,
        newWriter: prisma17,
        newReplica: prisma17,
        legacyWriter: prisma14,
        legacyReplica: prisma14,
        singleWriter: prisma14,
        singleReplica: prisma14,
      });

      const items = await serializeSessionsWithFriendlyRunIds(
        [sessionNew, sessionLegacy, sessionNull, sessionCross],
        { projectId: ctx.projectId, runtimeEnvironmentId: ctx.environmentId },
        store
      );

      const byFriendly = new Map(items.map((i) => [i.id, i.currentRunId]));
      expect(byFriendly.get("session_bnew")).toBe("run_bnew");
      expect(byFriendly.get("session_blegacy")).toBe("run_blegacy");
      expect(byFriendly.get("session_bnull")).toBeNull();
      expect(byFriendly.get("session_bcross")).toBeNull();
    }
  );
});
