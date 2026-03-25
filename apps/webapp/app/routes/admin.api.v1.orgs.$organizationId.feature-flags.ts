import { ActionFunctionArgs, LoaderFunctionArgs, json } from "@remix-run/server-runtime";
import { z } from "zod";
import { prisma } from "~/db.server";
import { authenticateApiRequestWithPersonalAccessToken } from "~/services/personalAccessToken.server";
import { validatePartialFeatureFlags } from "~/v3/featureFlags.server";

const ParamsSchema = z.object({
  organizationId: z.string(),
});

async function authenticateAdmin(request: Request) {
  const authenticationResult = await authenticateApiRequestWithPersonalAccessToken(request);

  if (!authenticationResult) {
    return { error: json({ error: "Invalid or Missing API key" }, { status: 401 }) };
  }

  const user = await prisma.user.findUnique({
    where: {
      id: authenticationResult.userId,
    },
  });

  if (!user) {
    return { error: json({ error: "Invalid or Missing API key" }, { status: 401 }) };
  }

  if (!user.admin) {
    return { error: json({ error: "You must be an admin to perform this action" }, { status: 403 }) };
  }

  return { user };
}

export async function loader({ request, params }: LoaderFunctionArgs) {
  const authResult = await authenticateAdmin(request);

  if ("error" in authResult) {
    return authResult.error;
  }

  const { organizationId } = ParamsSchema.parse(params);

  const organization = await prisma.organization.findUnique({
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
  const authResult = await authenticateAdmin(request);

  if ("error" in authResult) {
    return authResult.error;
  }

  const { organizationId } = ParamsSchema.parse(params);

  const organization = await prisma.organization.findUnique({
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

    const mergedFlags = {
      ...(existingFlags.success ? existingFlags.data : {}),
      ...validationResult.data,
    };

    // Update the organization's feature flags
    const updatedOrganization = await prisma.organization.update({
      where: {
        id: organizationId,
      },
      data: {
        featureFlags: mergedFlags,
      },
      select: {
        id: true,
        slug: true,
        featureFlags: true,
      },
    });

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
