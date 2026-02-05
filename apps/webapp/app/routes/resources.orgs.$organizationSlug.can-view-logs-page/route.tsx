import { type LoaderFunctionArgs } from "@remix-run/server-runtime";
import { typedjson } from "remix-typedjson";
import { requireUser } from "~/services/session.server";
import { prisma } from "~/db.server";
import { FEATURE_FLAG, validateFeatureFlagValue } from "~/v3/featureFlags.server";
import { OrganizationParamsSchema } from "~/utils/pathBuilder";

async function hasLogsPageAccess(
  userId: string,
  isAdmin: boolean,
  isImpersonating: boolean,
  organizationSlug: string
): Promise<boolean> {
  if (isAdmin || isImpersonating) {
    return true;
  }

  const organization = await prisma.organization.findFirst({
    where: {
      slug: organizationSlug,
      members: { some: { userId } },
    },
    select: {
      featureFlags: true,
    },
  });

  if (!organization?.featureFlags) {
    return false;
  }

  const flags = organization.featureFlags as Record<string, unknown>;
  const hasLogsPageAccessResult = validateFeatureFlagValue(
    FEATURE_FLAG.hasLogsPageAccess,
    flags.hasLogsPageAccess
  );

  return hasLogsPageAccessResult.success && hasLogsPageAccessResult.data === true;
}

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const user = await requireUser(request);
  const { organizationSlug } = OrganizationParamsSchema.parse(params);

  const canViewLogsPage = user.admin || user.isImpersonating || await hasLogsPageAccess(
    user.id,
    user.admin,
    user.isImpersonating,
    organizationSlug
  );

  return typedjson({ canViewLogsPage });
};
