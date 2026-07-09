import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/server-runtime";
import { json } from "@remix-run/server-runtime";
import type { Prisma } from "@trigger.dev/database";
import { z } from "zod";
import { env } from "~/env.server";
import { prisma } from "~/db.server";
import { requireAdminApiRequest } from "~/services/personalAccessToken.server";
import { controlPlaneResolver } from "~/v3/runOpsMigration/controlPlaneResolver.server";
import { stampMintKindFlip } from "~/v3/runOpsMigration/mintFlipGrace";
import { validatePartialFeatureFlags } from "~/v3/featureFlags";

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

  const organization = await prisma.organization.findFirst({
    where: {
      id: organizationId,
    },
    select: {
      id: true,
      featureFlags: true,
    },
  });

  if (!organization) {
    return json({ error: "Organization not found" }, { status: 404 });
  }

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

    // Merge new flags with existing flags
    const existingFlags = organization.featureFlags
      ? validatePartialFeatureFlags(organization.featureFlags as Record<string, unknown>)
      : { success: false as const };

    const mergedFlags = stampMintKindFlip(
      existingFlags.success ? existingFlags.data : {},
      {
        ...(existingFlags.success ? existingFlags.data : {}),
        ...validationResult.data,
      },
      Date.now(),
      env.RUN_OPS_MINT_FLIP_GRACE_MS
    );

    // Update the organization's feature flags
    const updatedOrganization = await prisma.organization.update({
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
