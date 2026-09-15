// Track 2 THREE-database topology proof. Before Track 2 the legacy run-ops client was an ALIAS of the
// control-plane client (legacyRunOps = controlPlane), so a cuid run's rows physically landed in the
// control-plane DB. Track 2 makes the legacy client INDEPENDENT (its own DSN). This test stands up
// three DISTINCT physical databases — control-plane, legacy, new — and proves:
//   - a cuid (LEGACY) run's routed create/read lands on the LEGACY DB, and is ABSENT from both the
//     control-plane DB and the new DB;
//   - a run-ops id (NEW) run's routed create/read lands on the NEW DB, and is ABSENT from both the
//     legacy DB and the control-plane DB;
//   - control-plane-model access (Organization) stays on the control-plane DB, unaffected by and
//     invisible to the legacy DB — i.e. legacy is genuinely NOT the control-plane DB anymore.
//
// `threeDbRunOpsPostgresTest` gives controlPlanePrisma + legacyPrisma (two SEPARATE clones of the full
// control-plane schema) and newPrisma (the @internal/run-ops-database SUBSET schema on its own
// container). NEVER mocked — three real Postgres databases.

import { threeDbRunOpsPostgresTest } from "@internal/testcontainers";
import type { PrismaClient } from "@trigger.dev/database";
import type { RunOpsPrismaClient } from "@internal/run-ops-database";
import { describe, expect } from "vitest";
import { PostgresRunStore } from "./PostgresRunStore.js";
import { RoutingRunStore } from "./runOpsStore.js";
import type { CreateRunInput, RunStoreSchemaVariant } from "./types.js";

type AnyClient = PrismaClient | RunOpsPrismaClient;

// ownerEngine classifies the internal id (after stripping a single `<prefix>_`): 25-char body → cuid →
// LEGACY; a v1 body (version "1" at index 25) → run-ops id → NEW.
const CUID_25 = "c".repeat(25); // → LEGACY (legacy full-schema DB)
const NEW_ID_26 = "k".repeat(24) + "01"; // → NEW (dedicated subset DB)

async function seedEnvironmentLegacy(prisma: PrismaClient, suffix: string) {
  const organization = await prisma.organization.create({
    data: { title: `Org ${suffix}`, slug: `org-${suffix}` },
  });
  const project = await prisma.project.create({
    data: {
      name: `Project ${suffix}`,
      slug: `project-${suffix}`,
      externalRef: `proj_${suffix}`,
      organizationId: organization.id,
    },
  });
  const environment = await prisma.runtimeEnvironment.create({
    data: {
      type: "DEVELOPMENT",
      slug: "dev",
      projectId: project.id,
      organizationId: organization.id,
      apiKey: `tr_dev_${suffix}`,
      pkApiKey: `pk_dev_${suffix}`,
      shortcode: `short_${suffix}`,
    },
  });
  return { organization, project, environment };
}

// On the dedicated subset there are no Organization/Project/RuntimeEnvironment models (the run-ops rows
// carry FK-free scalar ids), so synthetic owning ids are enough.
function seedEnvironmentDedicated(suffix: string) {
  return {
    organization: { id: `org_${suffix}` },
    project: { id: `proj_${suffix}` },
    environment: { id: `env_${suffix}` },
  };
}

function buildCreateRunInput(params: {
  runId: string;
  friendlyId: string;
  organizationId: string;
  projectId: string;
  runtimeEnvironmentId: string;
}): CreateRunInput {
  return {
    data: {
      id: params.runId,
      engine: "V2",
      status: "PENDING",
      friendlyId: params.friendlyId,
      runtimeEnvironmentId: params.runtimeEnvironmentId,
      environmentType: "DEVELOPMENT",
      organizationId: params.organizationId,
      projectId: params.projectId,
      taskIdentifier: "my-task",
      payload: "{}",
      payloadType: "application/json",
      traceContext: {},
      traceId: `trace_${params.runId}`,
      spanId: `span_${params.runId}`,
      queue: "task/my-task",
      isTest: false,
      taskEventStore: "taskEvent",
      depth: 0,
    },
    snapshot: {
      engine: "V2",
      executionStatus: "RUN_CREATED",
      description: "Run was created",
      runStatus: "PENDING",
      environmentId: params.runtimeEnvironmentId,
      environmentType: "DEVELOPMENT",
      projectId: params.projectId,
      organizationId: params.organizationId,
    },
  };
}

function makeStore(prisma: AnyClient, schemaVariant: RunStoreSchemaVariant) {
  return new PostgresRunStore({
    prisma: prisma as never,
    readOnlyPrisma: prisma as never,
    schemaVariant,
  });
}

async function findRunId(client: AnyClient, id: string): Promise<string | null> {
  const row = await (client as PrismaClient).taskRun.findFirst({
    where: { id },
    select: { friendlyId: true },
  });
  return row?.friendlyId ?? null;
}

describe("run-ops split — three-database topology (control-plane ≠ legacy ≠ new)", () => {
  threeDbRunOpsPostgresTest(
    "a cuid run routes to the LEGACY DB and never touches control-plane or new",
    async ({ controlPlanePrisma, legacyPrisma, newPrisma }) => {
      const legacyStore = makeStore(legacyPrisma, "legacy");
      const newStore = makeStore(newPrisma, "dedicated");
      const router = new RoutingRunStore({ new: newStore, legacy: legacyStore });

      const seed = await seedEnvironmentLegacy(legacyPrisma, "cuid_leg");
      const runId = `run_${CUID_25}`; // → LEGACY

      await router.createRun(
        buildCreateRunInput({
          runId,
          friendlyId: "run_cuid_legacy",
          organizationId: seed.organization.id,
          projectId: seed.project.id,
          runtimeEnvironmentId: seed.environment.id,
        })
      );

      // WRITE landed on the LEGACY physical DB only.
      expect(await findRunId(legacyPrisma, runId)).toBe("run_cuid_legacy");
      expect(await findRunId(controlPlanePrisma, runId)).toBeNull();
      expect(await findRunId(newPrisma, runId)).toBeNull();

      // Routed READ resolves the run (from the legacy DB).
      const read = await router.findRun({ id: runId }, { select: { friendlyId: true } });
      expect(read?.friendlyId).toBe("run_cuid_legacy");
    },
    120_000
  );

  threeDbRunOpsPostgresTest(
    "a run-ops id run routes to the NEW DB and never touches legacy or control-plane",
    async ({ controlPlanePrisma, legacyPrisma, newPrisma }) => {
      const legacyStore = makeStore(legacyPrisma, "legacy");
      const newStore = makeStore(newPrisma, "dedicated");
      const router = new RoutingRunStore({ new: newStore, legacy: legacyStore });

      const seed = seedEnvironmentDedicated("newid");
      const runId = `run_${NEW_ID_26}`; // → NEW

      await router.createRun(
        buildCreateRunInput({
          runId,
          friendlyId: "run_ops_new",
          organizationId: seed.organization.id,
          projectId: seed.project.id,
          runtimeEnvironmentId: seed.environment.id,
        })
      );

      // WRITE landed on the NEW physical DB only.
      expect(await findRunId(newPrisma, runId)).toBe("run_ops_new");
      expect(await findRunId(legacyPrisma, runId)).toBeNull();
      expect(await findRunId(controlPlanePrisma, runId)).toBeNull();

      // Routed READ resolves the run (from the new DB).
      const read = await router.findRun({ id: runId }, { select: { friendlyId: true } });
      expect(read?.friendlyId).toBe("run_ops_new");
    },
    120_000
  );

  threeDbRunOpsPostgresTest(
    "control-plane-model access stays on the control-plane DB, independent of the legacy DB",
    async ({ controlPlanePrisma, legacyPrisma, newPrisma }) => {
      const legacyStore = makeStore(legacyPrisma, "legacy");
      const newStore = makeStore(newPrisma, "dedicated");
      const router = new RoutingRunStore({ new: newStore, legacy: legacyStore });

      // A control-plane-model write goes to the control-plane DB.
      const cpOrg = await controlPlanePrisma.organization.create({
        data: { title: "CP Org", slug: "cp-org" },
      });

      // Route a cuid run through the store (writes run-graph rows to the LEGACY DB) alongside the
      // control-plane org — the two must not bleed across databases.
      const seed = await seedEnvironmentLegacy(legacyPrisma, "cp_indep");
      const runId = `run_${CUID_25}`;
      await router.createRun(
        buildCreateRunInput({
          runId,
          friendlyId: "run_cp_indep",
          organizationId: seed.organization.id,
          projectId: seed.project.id,
          runtimeEnvironmentId: seed.environment.id,
        })
      );

      // The control-plane org lives on the control-plane DB and is INVISIBLE to the legacy DB.
      expect(
        await controlPlanePrisma.organization.findFirst({ where: { id: cpOrg.id } })
      ).not.toBeNull();
      expect(await legacyPrisma.organization.findFirst({ where: { id: cpOrg.id } })).toBeNull();

      // The legacy-seeded org lives on the legacy DB and is INVISIBLE to the control-plane DB —
      // proving legacy is genuinely a separate physical database from control-plane.
      expect(
        await legacyPrisma.organization.findFirst({ where: { id: seed.organization.id } })
      ).not.toBeNull();
      expect(
        await controlPlanePrisma.organization.findFirst({ where: { id: seed.organization.id } })
      ).toBeNull();

      // And the legacy run never leaked onto the control-plane DB.
      expect(await findRunId(legacyPrisma, runId)).toBe("run_cp_indep");
      expect(await findRunId(controlPlanePrisma, runId)).toBeNull();
    },
    120_000
  );
});
