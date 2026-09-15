// Property: the waitpoint-complete token read tolerates replica lag. The three completion routes read
// the waitpoint by id (findWaitpoint with NO client) before completing it, which routes to the OWNING
// store's REPLICA — and a `{id}` lookup resolves the owning store via a replica probe first, so a
// just-minted, not-yet-replicated token is invisible on both. Each route re-reads via
// findWaitpointOnPrimary on a null. Pins both legs with the shared lagging-replica primitive on the
// real split topology (never mocked): findWaitpoint(id) is null under lag; findWaitpointOnPrimary(id)
// resolves it.

import { heteroRunOpsPostgresTest, laggingReplica } from "@internal/testcontainers";
import type { PrismaClient } from "@trigger.dev/database";
import type { RunOpsPrismaClient } from "@internal/run-ops-database";
import { generateRunOpsId } from "@trigger.dev/core/v3/isomorphic";
import { describe, expect } from "vitest";
import { PostgresRunStore } from "./PostgresRunStore.js";
import { RoutingRunStore } from "./runOpsStore.js";
import type { RunStoreSchemaVariant } from "./types.js";

type AnyClient = PrismaClient | RunOpsPrismaClient;

const CUID_25 = "d".repeat(25); // waitpoint id shape -> LEGACY (#legacy / prisma14, full schema)

// On the dedicated subset there are no Organization/Project/RuntimeEnvironment models (run-ops rows
// carry FK-free scalar ids), so mint synthetic owning ids; on legacy seed the real rows the FKs need.
async function seedEnvironment(
  prisma: AnyClient,
  schemaVariant: RunStoreSchemaVariant,
  slugSuffix: string
) {
  if (schemaVariant === "dedicated") {
    return {
      organization: { id: `org_${slugSuffix}` },
      project: { id: `proj_${slugSuffix}` },
      environment: { id: `env_${slugSuffix}` },
    };
  }
  const organization = await (prisma as PrismaClient).organization.create({
    data: { title: `Org ${slugSuffix}`, slug: `org-${slugSuffix}` },
  });
  const project = await (prisma as PrismaClient).project.create({
    data: {
      name: `Project ${slugSuffix}`,
      slug: `project-${slugSuffix}`,
      externalRef: `proj_${slugSuffix}`,
      organizationId: organization.id,
    },
  });
  const environment = await (prisma as PrismaClient).runtimeEnvironment.create({
    data: {
      type: "DEVELOPMENT",
      slug: "dev",
      projectId: project.id,
      organizationId: organization.id,
      apiKey: `tr_dev_${slugSuffix}`,
      pkApiKey: `pk_dev_${slugSuffix}`,
      shortcode: `short_${slugSuffix}`,
    },
  });
  return { organization, project, environment };
}

// Seed a standalone, still-PENDING MANUAL token waitpoint on the WRITER, exactly as minting a resume
// token does. The completion routes look it up by id right after; under replica lag that read misses.
async function seedPendingTokenWaitpoint(
  store: PostgresRunStore,
  params: { id: string; friendlyId: string; projectId: string; environmentId: string }
) {
  await store.upsertWaitpoint({
    where: {
      environmentId_idempotencyKey: {
        environmentId: params.environmentId,
        idempotencyKey: params.id,
      },
    },
    create: {
      id: params.id,
      friendlyId: params.friendlyId,
      type: "MANUAL",
      status: "PENDING",
      idempotencyKey: params.id,
      userProvidedIdempotencyKey: false,
      projectId: params.projectId,
      environmentId: params.environmentId,
    },
    update: {},
  });
}

describe("run-ops split — waitpoint-complete token read: replica misses a just-minted token, primary resolves it", () => {
  // (a) LEGACY-resident (cuid) token: minted on the control-plane writer; its replica lags. The
  // completion routes' `findWaitpoint({ where: { id } })` must NOT strand the token.
  heteroRunOpsPostgresTest(
    "LEGACY cuid: findWaitpoint(id) is null under replica lag; findWaitpointOnPrimary(id) resolves it",
    async ({ prisma14, prisma17 }) => {
      const legacyReplica = laggingReplica(prisma14, [{ model: "waitpoint", mode: "missing" }]);
      const legacyStore = new PostgresRunStore({
        prisma: prisma14,
        readOnlyPrisma: legacyReplica.client,
        schemaVariant: "legacy",
      });
      const newStore = new PostgresRunStore({
        prisma: prisma17 as never,
        readOnlyPrisma: prisma17 as never,
        schemaVariant: "dedicated",
      });
      const router = new RoutingRunStore({ new: newStore, legacy: legacyStore });

      const seed = await seedEnvironment(prisma14, "legacy", "wctok_leg");
      const waitpointId = `waitpoint_${CUID_25}`; // cuid -> LEGACY
      await seedPendingTokenWaitpoint(legacyStore, {
        id: waitpointId,
        friendlyId: "waitpoint_wctok_leg",
        projectId: seed.project.id,
        environmentId: seed.environment.id,
      });

      // The exact completion-route read (no client, by id). Under lag it misses the just-minted token;
      // a bare null would strand a token that exists on the primary.
      const fromReplica = await router.findWaitpoint({
        where: { id: waitpointId, environmentId: seed.environment.id },
      });
      expect(fromReplica).toBeNull();
      expect(legacyReplica.wasHit()).toBe(true);

      // The read-your-writes fallback each completion route applies: a re-read on the owning primary
      // resolves the token.
      const fromPrimary = await router.findWaitpointOnPrimary({
        where: { id: waitpointId, environmentId: seed.environment.id },
      });
      expect(fromPrimary).not.toBeNull();
      expect(fromPrimary!.id).toBe(waitpointId);
      expect(fromPrimary!.status).toBe("PENDING");
    }
  );

  // (b) NEW-resident (run-ops id) token on the dedicated subset schema: the NEW replica lags.
  heteroRunOpsPostgresTest(
    "NEW id: findWaitpoint(id) is null under NEW replica lag; findWaitpointOnPrimary(id) resolves it",
    async ({ prisma14, prisma17 }) => {
      const newReplica = laggingReplica(prisma17, [{ model: "waitpoint", mode: "missing" }]);
      const newStore = new PostgresRunStore({
        prisma: prisma17 as never,
        readOnlyPrisma: newReplica.client as never,
        schemaVariant: "dedicated",
      });
      const legacyStore = new PostgresRunStore({
        prisma: prisma14,
        readOnlyPrisma: prisma14,
        schemaVariant: "legacy",
      });
      const router = new RoutingRunStore({ new: newStore, legacy: legacyStore });

      const seed = await seedEnvironment(prisma17, "dedicated", "wctok_new");
      const waitpointId = `waitpoint_${generateRunOpsId()}`; // run-ops id -> NEW
      await seedPendingTokenWaitpoint(newStore, {
        id: waitpointId,
        friendlyId: "waitpoint_wctok_new",
        projectId: seed.project.id,
        environmentId: seed.environment.id,
      });

      const fromReplica = await router.findWaitpoint({
        where: { id: waitpointId, environmentId: seed.environment.id },
      });
      expect(fromReplica).toBeNull();
      expect(newReplica.wasHit()).toBe(true);

      const fromPrimary = await router.findWaitpointOnPrimary({
        where: { id: waitpointId, environmentId: seed.environment.id },
      });
      expect(fromPrimary).not.toBeNull();
      expect(fromPrimary!.id).toBe(waitpointId);
      expect(fromPrimary!.status).toBe("PENDING");
    }
  );
});
