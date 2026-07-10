import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/server-runtime";
import { json } from "@remix-run/server-runtime";
import type { Prisma } from "@trigger.dev/database";
import { z } from "zod";
import { env } from "~/env.server";
import { prisma } from "~/db.server";
import { requireAdminApiRequest } from "~/services/personalAccessToken.server";
import { controlPlaneResolver } from "~/v3/runOpsMigration/controlPlaneResolver.server";
import { selectMintBaselineSource, stampMintKindFlip } from "~/v3/runOpsMigration/mintFlipGrace";
import { validatePartialFeatureFlags } from "~/v3/featureFlags";
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
      ...requestedFlags
    } = validationResult.data;

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

      return tx.organization.update({
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
    });

    if (!updatedOrganization) {
      return json({ error: "Organization not found" }, { status: 404 });
    }

    // Org feature flags are embedded in every env of the org; drop all its cached env rows.
    controlPlaneResolver.invalidateOrganization(organizationId);

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
