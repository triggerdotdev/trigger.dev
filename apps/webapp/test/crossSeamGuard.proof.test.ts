import { heteroPostgresTest } from "@internal/testcontainers";
import type { PrismaClient } from "@trigger.dev/database";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  computeStoreForCompletion,
  selectStoreForWaitpoint,
} from "~/v3/runOpsMigration/crossSeamGuard.server";
import {
  expectedCompleteWaitpointCallSites,
  UNBLOCK_ROUTES,
} from "~/v3/runOpsMigration/unblockRouteCatalog";
import { WaitpointId } from "@trigger.dev/core/v3/isomorphic";

const NEW_WP = WaitpointId.toFriendlyId("0".repeat(24) + "01"); // v1 internal body → NEW
const LEGACY_WP = WaitpointId.toFriendlyId("c".repeat(25)); // 25-char internal body → LEGACY

describe("cross-seam guard — exhaustive per-route store selection", () => {
  for (const route of UNBLOCK_ROUTES) {
    it(`routes ${route.id} (${route.kind}) to new store for a NEW waitpoint`, () => {
      const d = selectStoreForWaitpoint({ waitpointId: NEW_WP, routeKind: route.kind });
      expect(d.store).toBe("new");
      expect(d.residency).toBe("NEW");
    });

    it(`routes ${route.id} (${route.kind}) to legacy store for a LEGACY waitpoint`, () => {
      const d = selectStoreForWaitpoint({ waitpointId: LEGACY_WP, routeKind: route.kind });
      expect(d.store).toBe("legacy");
      expect(d.residency).toBe("LEGACY");
    });
  }
});

describe("cross-seam guard — single-DB no-op", () => {
  for (const route of UNBLOCK_ROUTES) {
    it(`${route.id}: single-DB returns legacy without consulting the classifier`, () => {
      const calls: string[] = [];
      const d = computeStoreForCompletion(
        { waitpointId: "anything-even-unclassifiable", routeKind: route.kind },
        { splitEnabled: false, classify: (id) => (calls.push(id), "NEW") }
      );
      expect(d.store).toBe("legacy"); // the single store
      expect(calls).toEqual([]); // classifier never consulted
    });
  }
});

const ENGINE_FILES = [
  "internal-packages/run-engine/src/engine/index.ts",
  "internal-packages/run-engine/src/engine/systems/waitpointSystem.ts",
  "internal-packages/run-engine/src/engine/systems/ttlSystem.ts",
  "internal-packages/run-engine/src/engine/systems/runAttemptSystem.ts",
  "internal-packages/run-engine/src/engine/systems/batchSystem.ts",
];

function repoRoot(): string {
  let dir = process.cwd();
  while (!existsSync(path.join(dir, "pnpm-workspace.yaml"))) {
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error("repo root (pnpm-workspace.yaml) not found");
    dir = parent;
  }
  return dir;
}

function tally(sites: string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const site of sites) counts[site] = (counts[site] ?? 0) + 1;
  return counts;
}

describe("cross-seam guard — CI drift guard", () => {
  it("per-file completeWaitpoint( tally in source matches the catalog", () => {
    const root = repoRoot();

    // The regex matches tokens inside comments too — deliberate. Any textual
    // addition forces catalog reconciliation, so a new call site cannot land
    // without a matching entry.
    const liveSites: string[] = [];
    for (const file of ENGINE_FILES) {
      const src = readFileSync(path.join(root, file), "utf8");
      const hits = (src.match(/completeWaitpoint\(/g) ?? []).length;
      for (let i = 0; i < hits; i++) liveSites.push(file);
    }

    const cataloguedSites = expectedCompleteWaitpointCallSites().map((s) => s.site);

    expect(tally(liveSites)).toEqual(tally(cataloguedSites));
  });
});

// PG14+PG17 hetero-fixture proof. The pure-selection tests above prove the guard
// SELECTS the right store; this proves the selected store corresponds to the
// DB the Waitpoint row PHYSICALLY lives in, on a REAL heterogeneous PG14+PG17
// fixture. NEVER mock. Seed Org->Project->Env (parents before children, or the
// required Waitpoint.projectId/environmentId FKs abort the insert) then the
// Waitpoint, on the matching DB ONLY: NEW residency on PG17, LEGACY on PG14. The
// cross-DB toBeNull checks then prove no ghost row leaked to the other version.
// Seed pattern copied from
// internal-packages/run-engine/src/engine/tests/crossVersionCompat.test.ts.

const FIXED_TS = "2024-01-01 00:00:00+00";

async function seedOrgProjectEnv(
  p: PrismaClient,
  ids: { orgId: string; projectId: string; envId: string }
): Promise<void> {
  await p.$executeRawUnsafe(
    `INSERT INTO "Organization" ("id","slug","title","createdAt","updatedAt")
     VALUES ($1,$2,$3,$4::timestamptz,$4::timestamptz)`,
    ids.orgId,
    `${ids.orgId}-slug`,
    `${ids.orgId}-title`,
    FIXED_TS
  );

  await p.$executeRawUnsafe(
    `INSERT INTO "Project" ("id","slug","name","externalRef","organizationId","createdAt","updatedAt")
     VALUES ($1,$2,$3,$4,$5,$6::timestamptz,$6::timestamptz)`,
    ids.projectId,
    `${ids.projectId}-slug`,
    `${ids.projectId}-name`,
    `${ids.projectId}-ref`,
    ids.orgId,
    FIXED_TS
  );

  await p.$executeRawUnsafe(
    `INSERT INTO "RuntimeEnvironment"
       ("id","slug","apiKey","pkApiKey","shortcode","type","organizationId","projectId","createdAt","updatedAt")
     VALUES ($1,$2,$3,$4,$5,'DEVELOPMENT',$6,$7,$8::timestamptz,$8::timestamptz)`,
    ids.envId,
    `${ids.envId}-slug`,
    `${ids.envId}-apikey`,
    `${ids.envId}-pkapikey`,
    `${ids.envId}-short`,
    ids.orgId,
    ids.projectId,
    FIXED_TS
  );
}

async function seedWaitpoint(
  p: PrismaClient,
  ids: { waitpointId: string; projectId: string; envId: string; idempotencyKey: string }
): Promise<void> {
  await p.$executeRawUnsafe(
    `INSERT INTO "Waitpoint"
       ("id","friendlyId","type","status","idempotencyKey","userProvidedIdempotencyKey",
        "projectId","environmentId","createdAt","updatedAt")
     VALUES ($1,$2,'MANUAL','PENDING',$3,false,$4,$5,$6::timestamptz,$6::timestamptz)`,
    ids.waitpointId,
    `${ids.waitpointId}-friendly`,
    ids.idempotencyKey,
    ids.projectId,
    ids.envId,
    FIXED_TS
  );
}

describe("cross-seam guard — PG14+PG17 hetero-fixture proof", () => {
  heteroPostgresTest(
    "exhaustive routes resolve to the physically-correct store on PG14+PG17",
    async ({ prisma14, prisma17 }) => {
      const newWp = WaitpointId.toFriendlyId("0".repeat(24) + "01"); // NEW → PG17
      const legacyWp = WaitpointId.toFriendlyId("c".repeat(25)); // LEGACY → PG14

      // Distinct parent chains per residency; each Waitpoint lives on its own DB
      // ONLY so the cross-DB ghost assertions (toBeNull on the other version) hold.
      await seedOrgProjectEnv(prisma17, {
        orgId: "org_csm_new_0000000000000000000",
        projectId: "proj_csm_new_00000000000000000",
        envId: "env_csm_new_0000000000000000000",
      });
      await seedWaitpoint(prisma17, {
        waitpointId: newWp,
        projectId: "proj_csm_new_00000000000000000",
        envId: "env_csm_new_0000000000000000000",
        idempotencyKey: "idem_csm_new",
      });

      await seedOrgProjectEnv(prisma14, {
        orgId: "org_csm_legacy_0000000000000000",
        projectId: "proj_csm_legacy_000000000000000",
        envId: "env_csm_legacy_0000000000000000",
      });
      await seedWaitpoint(prisma14, {
        waitpointId: legacyWp,
        projectId: "proj_csm_legacy_000000000000000",
        envId: "env_csm_legacy_0000000000000000",
        idempotencyKey: "idem_csm_legacy",
      });

      // Exhaustive over every unblock route: the selected store must match the
      // DB the row physically lives in, with no cross-DB ghost in either direction.
      for (const route of UNBLOCK_ROUTES) {
        const dNew = selectStoreForWaitpoint({ waitpointId: newWp, routeKind: route.kind });
        expect(dNew.store).toBe("new");
        expect(await prisma17.waitpoint.findFirst({ where: { id: newWp } })).not.toBeNull();
        expect(await prisma14.waitpoint.findFirst({ where: { id: newWp } })).toBeNull();

        const dLegacy = selectStoreForWaitpoint({ waitpointId: legacyWp, routeKind: route.kind });
        expect(dLegacy.store).toBe("legacy");
        expect(await prisma14.waitpoint.findFirst({ where: { id: legacyWp } })).not.toBeNull();
        expect(await prisma17.waitpoint.findFirst({ where: { id: legacyWp } })).toBeNull();
      }
    },
    // First run boots two real Postgres containers (PG14 + PG17); the default
    // 5s per-test timeout is far too short for the cold image pull + start.
    120_000
  );
});
