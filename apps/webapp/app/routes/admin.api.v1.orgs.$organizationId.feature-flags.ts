import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/server-runtime";
import { json } from "@remix-run/server-runtime";
import type { Prisma } from "@trigger.dev/database";
import { z } from "zod";
import { env } from "~/env.server";
import { prisma } from "~/db.server";
import { requireAdminApiRequest } from "~/services/personalAccessToken.server";
import { controlPlaneResolver } from "~/v3/runOpsMigration/controlPlaneResolver.server";
import { globalFlagsRegistry } from "~/v3/globalFlagsRegistry.server";
import { snapshotStoreFlagSaveError } from "~/v3/snapshotStoreFlagGuard.server";
import { selectMintBaselineSource, stampMintKindFlip } from "~/v3/runOpsMigration/mintFlipGrace";
import {
  FEATURE_FLAG,
  FeatureFlagCatalog,
  stampSnapshotStoreOrgEverEnabled,
  validatePartialFeatureFlags,
  withoutOrgForbiddenSnapshotKeys,
} from "~/v3/featureFlags";
import { flags as getGlobalFlags } from "~/v3/featureFlags.server";

const ParamsSchema = z.object({
  organizationId: z.string(),
});

export async function loader({ request, params }: LoaderFunctionArgs) {
  await requireAdminApiRequest(request);

  const { organizationId } = ParamsSchema.parse(params);

  const organization = await prisma.organization.findFirst({
    where: {
      id: organizationId,
    },
    select: {
      id: true,
      slug: true,
      featureFlags: true,
    },
  });

  if (!organization) {
    return json({ error: "Organization not found" }, { status: 404 });
  }

  const flagsResult = organization.featureFlags
    ? validatePartialFeatureFlags(organization.featureFlags as Record<string, unknown>)
    : { success: false as const };

  const featureFlags = flagsResult.success ? flagsResult.data : {};

  return json({
    organizationId: organization.id,
    organizationSlug: organization.slug,
    featureFlags,
  });
}

export async function action({ request, params }: ActionFunctionArgs) {
  await requireAdminApiRequest(request);

  const { organizationId } = ParamsSchema.parse(params);

  try {
    const body = await request.json();

    // Validate the input using the partial schema
    const validationResult = validatePartialFeatureFlags(body as Record<string, unknown>);
    if (!validationResult.success) {
      return json(
        {
          error: "Invalid feature flags data",
          details: validationResult.error.issues,
        },
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
      // Read from the live registry, not from the payload: the latch must ALREADY be true before
      // anything can be enabled, or a run born in the gap would be resident with its transitions
      // skipped.
      everEnabled: globalFlagsRegistry.current()?.[FEATURE_FLAG.snapshotStoreEverEnabled] === true,
    });
    if (snapshotStoreError) {
      return json({ error: snapshotStoreError }, { status: 400 });
    }

    // Seed the flip baseline from the current GLOBAL mint flags so an org's FIRST per-org override
    // is graced from the currently-effective global kind, not the hardcoded default "cuid".
    const globalFlags = (await getGlobalFlags()) as Record<string, unknown>;

    // Lock the org row for the whole read -> merge -> stamp -> write so a concurrent flag save
    // can't clobber the grace metadata (read-then-write race). PK lookup, one row, held to commit.
    const updatedOrganization = await prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<{ featureFlags: unknown }[]>`
        SELECT "featureFlags" FROM "Organization" WHERE "id" = ${organizationId} FOR UPDATE`;

      if (rows.length === 0) {
        return null;
      }

      const existingRaw = rows[0].featureFlags as Record<string, unknown> | null;
      const existingResult = existingRaw
        ? validatePartialFeatureFlags(existingRaw)
        : ({ success: false } as const);
      const existingData = existingResult.success ? existingResult.data : {};

      // Stamp the flip from the control-plane DB clock so the grace-window cutover is anchored to
      // one authoritative time source, not whichever webapp process handled this request.
      const [{ now: controlPlaneNow }] = await tx.$queryRaw<{ now: Date }[]>`SELECT now() AS now`;

      const mergedFlags = stampMintKindFlip(
        selectMintBaselineSource(existingRaw, globalFlags),
        {
          ...existingData,
          ...requestedFlags,
        },
        controlPlaneNow.getTime(),
        env.RUN_OPS_MINT_FLIP_GRACE_MS
      );

      // One-way per-org residency latch, exactly as the v2 route does. Without it a run born after
      // this enable is resident but the census keeps classifying the org definitely-never-enabled, so
      // its transitions are skipped and its Redis head freezes. ORed against the locked existing value
      // so a save back to off never clears it.
      stampSnapshotStoreOrgEverEnabled(existingRaw, mergedFlags);

      const updated = await tx.organization.update({
        where: {
          id: organizationId,
        },
        data: {
          featureFlags: mergedFlags as Prisma.InputJsonValue,
        },
        select: {
          id: true,
          slug: true,
          featureFlags: true,
        },
      });

      // Maintain this org's entry in the global cohort dial map with a single atomic jsonb_set (no
      // read-modify-write of the map, so concurrent org saves can't clobber each other). Presence
      // is the one-way enrollment latch; "off" is a stored value, never a deletion.
      const orgDialParsed = FeatureFlagCatalog[FEATURE_FLAG.snapshotStoreOrgMode].safeParse(
        mergedFlags[FEATURE_FLAG.snapshotStoreOrgMode]
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

      return updated;
    });

    if (!updatedOrganization) {
      return json({ error: "Organization not found" }, { status: 404 });
    }

    // Org feature flags are embedded in every env of the org; drop all its cached env rows.
    controlPlaneResolver.invalidateOrganization(organizationId);
    // Reload the global registry in THIS process at once so the writing pod converges on the new
    // cohort dial immediately. Other pods lag at most the reload interval.
    void globalFlagsRegistry.reload();

    const updatedFlagsResult = updatedOrganization.featureFlags
      ? validatePartialFeatureFlags(updatedOrganization.featureFlags as Record<string, unknown>)
      : { success: false as const };

    return json({
      success: true,
      organizationId: updatedOrganization.id,
      organizationSlug: updatedOrganization.slug,
      featureFlags: updatedFlagsResult.success ? updatedFlagsResult.data : {},
    });
  } catch (error) {
    return json(
      {
        error: error instanceof Error ? error.message : String(error),
      },
      { status: 400 }
    );
  }
}
