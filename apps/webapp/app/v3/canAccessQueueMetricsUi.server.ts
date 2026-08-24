import { prisma } from "~/db.server";
import { getImpersonationState } from "~/services/impersonation.server";
import { resolveQueueMetricsUiAccess } from "~/utils/queueMetricsUiAccess";
import { FEATURE_FLAG } from "~/v3/featureFlags";
import { makeFlag } from "~/v3/featureFlags.server";

// Per-org gate for the Queue Metrics dashboard UI. Org override wins over the global
// FeatureFlag table value, which wins over the off-by-default. Ingestion/emission is a
// separate global flag; this only decides whether an org sees the metrics view.
export async function canAccessQueueMetricsUi(options: {
  request: Request;
  userId: string;
  organizationSlug: string;
}): Promise<boolean> {
  const org = await prisma.organization.findFirst({
    where: {
      slug: options.organizationSlug,
      members: { some: { userId: options.userId } },
    },
    select: { featureFlags: true },
  });

  const flag = makeFlag();
  const flagEnabled = await flag({
    key: FEATURE_FLAG.queueMetricsUiEnabled,
    defaultValue: false,
    overrides: (org?.featureFlags as Record<string, unknown>) ?? {},
  });

  const { isImpersonating, isViewingAsUser } =
    flagEnabled || !org
      ? { isImpersonating: false, isViewingAsUser: false }
      : await getImpersonationState(options.request, options.userId);

  return resolveQueueMetricsUiAccess({ flagEnabled, isImpersonating, isViewingAsUser });
}
