// Per-env KSUID mint cutover integration proof.
//
// NEVER mocks the DB: the mint decision runs through the pure core `computeRunIdMintKind`
// wired to a REAL `makeFlag(prisma)` that reads the REAL `Organization.featureFlags` /
// `FeatureFlag` rows in a testcontainers Postgres. Only the two boundary knobs
// are injected — `masterEnabled` and the `splitEnabled` boot-boolean — never a
// mocked DB. The KSUID/cuid format + residency are then proven through the SAME isomorphic
// helpers the real trigger path uses (`generateKsuidId` / `RunId.toFriendlyId` /
// `RunId.fromFriendlyId` / `ownerEngine`).
import type { PrismaClient } from "@trigger.dev/database";
import { generateKsuidId, ownerEngine, RunId } from "@trigger.dev/core/v3/isomorphic";
import { postgresTest } from "@internal/testcontainers";
import { describe, expect, vi } from "vitest";
import {
  computeRunIdMintKind,
  type RunIdMintKind,
} from "~/v3/runOpsMigration/runOpsMintKind.server";
import { FEATURE_FLAG } from "~/v3/featureFlags";
import { makeFlag } from "~/v3/featureFlags.server";
import {
  createTestOrgProjectWithMember,
  createRuntimeEnvironment,
  uniqueId,
} from "./fixtures/environmentVariablesFixtures";

vi.setConfig({ testTimeout: 60_000 });

// The real trigger-path mint helper, copied verbatim from triggerTask.server.ts so the
// test exercises the exact id format a cut-over env produces.
function mintRunKsuidFriendlyId(): string {
  return RunId.toFriendlyId(generateKsuidId());
}

// Mirrors the real trigger path: resolve the kind, then mint either a KSUID friendlyId or
// the default cuid one (RunId.generate()).
function mintRunFriendlyId(kind: RunIdMintKind): string {
  return kind === "ksuid" ? mintRunKsuidFriendlyId() : RunId.generate().friendlyId;
}

async function seedOrgEnv(prisma: PrismaClient, mintFlag?: RunIdMintKind) {
  const { organization, project } = await createTestOrgProjectWithMember(prisma);
  const environment = await createRuntimeEnvironment(prisma, {
    projectId: project.id,
    organizationId: organization.id,
    type: "PRODUCTION",
    slug: uniqueId("prod"),
  });
  if (mintFlag) {
    await prisma.organization.update({
      where: { id: organization.id },
      data: { featureFlags: { [FEATURE_FLAG.runOpsMintKsuid]: mintFlag } },
    });
  }
  return { organization, environment };
}

// Build the env-bound `flag` dependency around a REAL makeFlag(prisma) reading the real
// Organization.featureFlags override store. Pure-core gets the real DB-backed flag; only
// masterEnabled + splitEnabled are injected boundary config.
function realFlag(prisma: PrismaClient) {
  const flagFn = makeFlag(prisma);
  return async (orgId: string, orgFeatureFlags: unknown | undefined): Promise<RunIdMintKind> => {
    const overrides =
      orgFeatureFlags !== undefined
        ? orgFeatureFlags
        : (
            await prisma.organization.findFirst({
              where: { id: orgId },
              select: { featureFlags: true },
            })
          )?.featureFlags;
    return flagFn({
      key: FEATURE_FLAG.runOpsMintKsuid,
      defaultValue: "cuid",
      overrides: (overrides as Record<string, unknown>) ?? {},
    });
  };
}

describe("per-env KSUID mint cutover", () => {
  postgresTest(
    "canary org mints KSUID/NEW; non-canary org mints cuid/LEGACY",
    async ({ prisma }) => {
      const a = await seedOrgEnv(prisma, "ksuid"); // canary
      const b = await seedOrgEnv(prisma); // not cut over

      const flag = realFlag(prisma);
      const deps = { masterEnabled: true, splitEnabled: async () => true, flag };

      const kindA = await computeRunIdMintKind(
        { organizationId: a.organization.id, id: a.environment.id },
        deps
      );
      const kindB = await computeRunIdMintKind(
        { organizationId: b.organization.id, id: b.environment.id },
        deps
      );

      expect(kindA).toBe("ksuid");
      expect(kindB).toBe("cuid");

      const friendlyA = mintRunFriendlyId(kindA);
      const friendlyB = mintRunFriendlyId(kindB);

      expect(RunId.fromFriendlyId(friendlyA).length).toBe(27);
      expect(ownerEngine(RunId.fromFriendlyId(friendlyA))).toBe("NEW");

      expect(RunId.fromFriendlyId(friendlyB).length).toBe(25);
      expect(ownerEngine(RunId.fromFriendlyId(friendlyB))).toBe("LEGACY");
    }
  );

  postgresTest(
    "split OFF mints cuid even for a flagged-ksuid org (split gate dominates)",
    async ({ prisma }) => {
      const a = await seedOrgEnv(prisma, "ksuid");
      const flag = vi.fn(realFlag(prisma));

      const kind = await computeRunIdMintKind(
        { organizationId: a.organization.id, id: a.environment.id },
        { masterEnabled: true, splitEnabled: async () => false, flag }
      );

      expect(kind).toBe("cuid");
      expect(flag).not.toHaveBeenCalled(); // gated off before any DB read
    }
  );

  postgresTest(
    "drain-new-forward (D8): flipping back to cuid stops new KSUID mints without reverting existing",
    async ({ prisma }) => {
      const a = await seedOrgEnv(prisma, "ksuid");
      const flag = realFlag(prisma);
      const deps = { masterEnabled: true, splitEnabled: async () => true, flag };

      // First run is born KSUID/NEW while cut over.
      const firstKind = await computeRunIdMintKind(
        { organizationId: a.organization.id, id: a.environment.id },
        deps
      );
      const firstFriendly = mintRunFriendlyId(firstKind);
      expect(firstKind).toBe("ksuid");
      expect(ownerEngine(RunId.fromFriendlyId(firstFriendly))).toBe("NEW");

      // Roll the org back to cuid (drain-new-forward — set the flag to "cuid").
      await prisma.organization.update({
        where: { id: a.organization.id },
        data: { featureFlags: { [FEATURE_FLAG.runOpsMintKsuid]: "cuid" } },
      });

      // The NEXT run mints cuid again (the env-bound resolver's TTL cache is not used here,
      // so the flip is observed immediately — production waits one cache TTL).
      const nextKind = await computeRunIdMintKind(
        { organizationId: a.organization.id, id: a.environment.id },
        deps
      );
      const nextFriendly = mintRunFriendlyId(nextKind);
      expect(nextKind).toBe("cuid");
      expect(ownerEngine(RunId.fromFriendlyId(nextFriendly))).toBe("LEGACY");

      // The already-minted KSUID run is untouched — drain-new-forward never reverts it.
      expect(RunId.fromFriendlyId(firstFriendly).length).toBe(27);
      expect(ownerEngine(RunId.fromFriendlyId(firstFriendly))).toBe("NEW");
    }
  );

  postgresTest(
    "parent and child re-resolve independently from their own org flag",
    async ({ prisma }) => {
      // Parent lives in a cut-over org; child is triggered into a NON-cut-over org.
      const parentOrg = await seedOrgEnv(prisma, "ksuid");
      const childOrg = await seedOrgEnv(prisma); // not cut over
      const flag = realFlag(prisma);
      const deps = { masterEnabled: true, splitEnabled: async () => true, flag };

      const parentKind = await computeRunIdMintKind(
        { organizationId: parentOrg.organization.id, id: parentOrg.environment.id },
        deps
      );
      const childKind = await computeRunIdMintKind(
        { organizationId: childOrg.organization.id, id: childOrg.environment.id },
        deps
      );

      // Observed behavior: the mint decision is resolved per the run's OWN org/env flag —
      // it does NOT inherit the parent's residency. A child in a non-cut-over org mints cuid
      // even when its parent was born KSUID. If children must inherit, that inheritance
      // belongs to the child-trigger path, not this resolver.
      expect(parentKind).toBe("ksuid");
      expect(childKind).toBe("cuid");
    }
  );
});
