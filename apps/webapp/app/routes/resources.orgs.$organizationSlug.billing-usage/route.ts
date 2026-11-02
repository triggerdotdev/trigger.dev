import { typedjson } from "remix-typedjson";
import { resolveOrgIdFromSlugForUser } from "~/models/organization.server";
import { billingUsage } from "~/services/billingUsageInstance.server";
import { dashboardLoader } from "~/services/routeBuilders/dashboardBuilder";
import { getUserId } from "~/services/session.server";
import { resolveUsageMonth, usageMonths } from "~/utils/billingUsagePeriod";
import { USAGE_PAGE_PARAMS } from "~/utils/billingUsagePageState";
import { OrganizationParamsSchema } from "~/utils/pathBuilder";

// Polled by the usage page while settled days are still being fetched: each call stores the next chunk.
export const loader = dashboardLoader(
  {
    params: OrganizationParamsSchema,
    context: async (params, request) => {
      const userId = await getUserId(request);
      if (!userId) return {};
      const organizationId = await resolveOrgIdFromSlugForUser(params.organizationSlug, userId);
      return organizationId ? { organizationId } : {};
    },
  },
  async ({ context, request }) => {
    if (!context.organizationId) {
      throw new Response(null, { status: 404, statusText: "Organization not found" });
    }

    const month = resolveUsageMonth(
      new URL(request.url).searchParams.get(USAGE_PAGE_PARAMS.month),
      usageMonths(new Date())
    );
    const [usage, projectUsage] = await Promise.all([
      billingUsage.getMonthlyUsage(context.organizationId, month, { loadPending: true }),
      billingUsage.getProjectUsage(context.organizationId, month, { loadPending: true }),
    ]);

    return typedjson({ month, usage, projectUsage });
  }
);
