import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/server-runtime";
import { json } from "@remix-run/server-runtime";
import { Prisma } from "@trigger.dev/database";
import { z } from "zod";
import { env } from "~/env.server";
import { $transaction, prisma } from "~/db.server";
import { requireUser } from "~/services/session.server";
import { controlPlaneResolver } from "~/v3/runOpsMigration/controlPlaneResolver.server";
import { globalFlagsRegistry } from "~/v3/globalFlagsRegistry.server";
import { snapshotStoreFlagSaveError } from "~/v3/snapshotStoreFlagGuard.server";
import { selectMintBaselineSource, stampMintKindFlip } from "~/v3/runOpsMigration/mintFlipGrace";
import { flags as getGlobalFlags } from "~/v3/featureFlags.server";
import {
  clearedOrgFlagsPreservingLatch,
  FEATURE_FLAG,
  FeatureFlagCatalog,
  stampSnapshotStoreOrgEverEnabled,
  validatePartialFeatureFlags,
  withoutOrgForbiddenSnapshotKeys,
  getAllFlagControlTypes,
} from "~/v3/featureFlags";
import { featuresForRequest } from "~/features.server";

// Session-auth route for the admin feature flags dialog.
// Uses replace semantics: the action writes the full flag set (or null to clear).
// Compare with v1 (admin.api.v1.orgs.$organizationId.feature-flags.ts) which
// uses PAT auth and merge semantics for programmatic use.

const ParamsSchema = z.object({
  organizationId: z.string(),
});

export async function loader({ request, params }: LoaderFunctionArgs) {
  const user = await requireUser(request);
  if (!user.admin) {
    throw new Response("Unauthorized", { status: 403 });
  }

  const { organizationId } = ParamsSchema.parse(params);

  const [organization, globalFlags, workerGroups] = await Promise.all([
    prisma.organization.findFirst({
      where: { id: organizationId },
      select: {
        id: true,
        title: true,
        slug: true,
        featureFlags: true,
      },
    }),
    getGlobalFlags(),
    prisma.workerInstanceGroup.findMany({
      select: { id: true, name: true },
      orderBy: { name: "asc" },
    }),
  ]);

  if (!organization) {
    throw new Response("Organization not found", { status: 404 });
  }

  const orgFlagsResult = organization.featureFlags
    ? validatePartialFeatureFlags(organization.featureFlags as Record<string, unknown>)
    : ({ success: false } as const);

  const orgFlags = orgFlagsResult.success ? orgFlagsResult.data : {};
  const controlTypes = getAllFlagControlTypes();

  // Resolve worker group name for display
  const workerGroupId = (globalFlags as Record<string, unknown>)?.[
    FEATURE_FLAG.defaultWorkerInstanceGroupId
  ];
  let workerGroupName: string | undefined;
  if (typeof workerGroupId === "string") {
    const wg = await prisma.workerInstanceGroup.findFirst({
      where: { id: workerGroupId },
      select: { name: true },
    });
    workerGroupName = wg?.name;
  }

  const { isManagedCloud } = featuresForRequest(request);

  return json({
    org: {
      id: organization.id,
      title: organization.title,
      slug: organization.slug,
    },
    orgFlags,
    globalFlags,
    controlTypes,
    workerGroupName,
    workerGroups,
    isManagedCloud,
  });
}

export async function action({ request, params }: ActionFunctionArgs) {
  const user = await requireUser(request);
  if (!user.admin) {
    throw new Response("Unauthorized", { status: 403 });
  }

  const { organizationId } = ParamsSchema.parse(params);

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (
    body === null ||
    (typeof body === "object" && !Array.isArray(body) && Object.keys(body).length === 0)
  ) {
    // Clear all flags, but preserve the one-way per-org residency latch so an ever-enabled org can
    // never drop out of the census. Locked read-then-write so a concurrent enabling save (which also
    // takes FOR UPDATE) can't slip a latch in between the read and the wipe.
    const updated = await $transaction(prisma, "adminOrgFlagsClear", async (tx) => {
      const rows = await tx.$queryRaw<{ featureFlags: unknown }[]>`
        SELECT "featureFlags" FROM "Organization" WHERE "id" = ${organizationId} FOR UPDATE`;

      if (rows.length === 0) {
        return false;
      }

      const preserved = clearedOrgFlagsPreservingLatch(
        rows[0].featureFlags as Record<string, unknown> | null
      );

      await tx.organization.update({
        where: { id: organizationId },
        data: {
          featureFlags: preserved === null ? Prisma.JsonNull : (preserved as Prisma.InputJsonValue),
        },
      });

      // A wipe clears the org's dial, so record "off" in the cohort map, but ONLY for an org still
      // enrolled after the wipe (clearedOrgFlagsPreservingLatch keeps the latch for one that was).
      // A never-enrolled org must not be auto-enrolled as "off" here (see the main save path).
      const enrolled = preserved?.[FEATURE_FLAG.snapshotStoreOrgEverEnabled] === true;
      if (enrolled) {
        const affected = await tx.$executeRaw`
          UPDATE "FeatureFlag"
          SET "value" = jsonb_set(COALESCE("value", '{}'::jsonb), ARRAY[${organizationId}], to_jsonb('off'::text)),
              "updatedAt" = now()
          WHERE "key" = ${FEATURE_FLAG.snapshotStoreOrgDials}`;
        if (affected === 0) {
          throw new Error("snapshotStoreOrgDials flag row missing; run the backfill migration");
        }
      }

      return true;
    });

    if (!updated) {
      throw new Response("Organization not found", { status: 404 });
    }

    controlPlaneResolver.invalidateOrganization(organizationId);
    void globalFlagsRegistry.reload();
    return json({ success: true });
  }

  const validationResult = validatePartialFeatureFlags(body as Record<string, unknown>);
  if (!validationResult.success) {
    return json(
      { error: "Invalid feature flags", details: validationResult.error.issues },
      { status: 400 }
    );
  }

  // Derived grace-stamp fields are computed server-side; never trust them from the body.
  const {
    runOpsMintKindPrev: _ignoredPrev,
    runOpsMintKindFlippedAt: _ignoredFlippedAt,
    ...rawRequestedFlags
  } = validationResult.data;

  const requestedFlags = withoutOrgForbiddenSnapshotKeys(rawRequestedFlags);

  const snapshotStoreError = snapshotStoreFlagSaveError(requestedFlags, {
    redisHostConfigured: !!env.RUN_ENGINE_SNAPSHOT_STORE_REDIS_HOST,
    // Read from the live registry, not the payload: the latch must ALREADY be true before anything
    // can be enabled, or a run born in the gap is resident with its transitions skipped.
    everEnabled: globalFlagsRegistry.current()?.[FEATURE_FLAG.snapshotStoreEverEnabled] === true,
  });
  if (snapshotStoreError) {
    return json({ error: snapshotStoreError }, { status: 400 });
  }

  // Seed the flip baseline from the current GLOBAL mint flags so an org's FIRST per-org override
  // is graced from the currently-effective global kind, not the hardcoded default "cuid".
  const globalFlags = (await getGlobalFlags()) as Record<string, unknown>;

  // Lock the org row for the whole read -> stamp -> write so a concurrent flag save can't clobber
  // the grace metadata (read-then-write race). PK lookup, one row, held to commit.
  const updated = await $transaction(prisma, "adminOrgFlagsSave", async (tx) => {
    const rows = await tx.$queryRaw<{ featureFlags: unknown }[]>`
      SELECT "featureFlags" FROM "Organization" WHERE "id" = ${organizationId} FOR UPDATE`;

    if (rows.length === 0) {
      return false;
    }

    const existingRaw = rows[0].featureFlags as Record<string, unknown> | null;

    // Anchor the flip stamp to the control-plane DB clock (see the v1 route), not this process's.
    const [{ now: controlPlaneNow }] = await tx.$queryRaw<{ now: Date }[]>`SELECT now() AS now`;

    const stamped = stampMintKindFlip(
      selectMintBaselineSource(existingRaw, globalFlags),
      requestedFlags,
      controlPlaneNow.getTime(),
      env.RUN_OPS_MINT_FLIP_GRACE_MS
    );

    // One-way per-org residency latch, ORed against the locked existing value so it never clears.
    stampSnapshotStoreOrgEverEnabled(existingRaw, stamped);

    await tx.organization.update({
      where: { id: organizationId },
      data: { featureFlags: stamped as Prisma.InputJsonValue },
    });

    // Maintain the cohort map ONLY for an enrolled org (latch set in the stamped blob). Writing a
    // never-enrolled org as "off" would auto-enroll it: the resolver reads a present "off" as an
    // opt-out that beats the global dial, silently pinning the org off the fleet rollout. Single
    // atomic jsonb_set; "off" is a stored value for a genuinely-enrolled org, never a deletion.
    const enrolled = stamped[FEATURE_FLAG.snapshotStoreOrgEverEnabled] === true;
    if (enrolled) {
      const orgDialParsed = FeatureFlagCatalog[FEATURE_FLAG.snapshotStoreOrgMode].safeParse(
        stamped[FEATURE_FLAG.snapshotStoreOrgMode]
      );
      const orgDial = orgDialParsed.success ? orgDialParsed.data : "off";
      const affected = await tx.$executeRaw`
        UPDATE "FeatureFlag"
        SET "value" = jsonb_set(COALESCE("value", '{}'::jsonb), ARRAY[${organizationId}], to_jsonb(${orgDial}::text)),
            "updatedAt" = now()
        WHERE "key" = ${FEATURE_FLAG.snapshotStoreOrgDials}`;
      if (affected === 0) {
        throw new Error("snapshotStoreOrgDials flag row missing; run the backfill migration");
      }
    }

    return true;
  });

  if (!updated) {
    throw new Response("Organization not found", { status: 404 });
  }

  // Org feature flags are embedded in every env of the org; drop all its cached env rows.
  controlPlaneResolver.invalidateOrganization(organizationId);
  // Reload the global registry in THIS process at once so the writing pod converges on the new
  // cohort dial immediately. Other pods lag at most the reload interval.
  void globalFlagsRegistry.reload();

  return json({ success: true });
}
