import type { ShouldRevalidateFunction } from "@remix-run/react";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { getUsageBarBillingLimitDollars } from "~/components/billing/billingAlertsFormat";
import { BillingUsageView } from "~/components/billing/usage/BillingUsageView";
import { PageContainer } from "~/components/layout/AppLayout";
import { NavBar, PageTitle } from "~/components/primitives/PageHeader";
import { useBillingLimit, useOrganization } from "~/hooks/useOrganizations";
import { resolveOrgIdFromSlug } from "~/models/organization.server";
import { billingUsage } from "~/services/billingUsageInstance.server";
import { dashboardLoader } from "~/services/routeBuilders/dashboardBuilder";
import { resolveUsageMonth, usageMonths } from "~/utils/billingUsagePeriod";
import { shouldReloadUsage, USAGE_PAGE_PARAMS } from "~/utils/billingUsagePageState";
import { OrganizationParamsSchema, v3BillingLimitsPath } from "~/utils/pathBuilder";
import { pageMeta } from "~/utils/pageTitle";
import { useCurrentPlan } from "../_app.orgs.$organizationSlug/route";

export const meta = pageMeta("Usage");

export const loader = dashboardLoader(
  {
    params: OrganizationParamsSchema,
    context: async (params) => {
      const organizationId = await resolveOrgIdFromSlug(params.organizationSlug);
      return organizationId ? { organizationId } : {};
    },
    authorization: { requireSuper: true },
  },
  async ({ context, request }) => {
    if (!context.organizationId) {
      throw new Response(null, { status: 404, statusText: "Organization not found" });
    }

    const now = new Date();
    const months = usageMonths(now);
    const month = resolveUsageMonth(
      new URL(request.url).searchParams.get(USAGE_PAGE_PARAMS.month),
      months
    );
    // Settled days not stored yet come in afterwards, through the page's polling of the resource route.
    const [usage, projectUsage, addOns] = await Promise.all([
      billingUsage.getMonthlyUsage(context.organizationId, month),
      billingUsage.getProjectUsage(context.organizationId, month),
      billingUsage.getAddOns(context.organizationId, month),
    ]);

    return typedjson({ months, month, usage, projectUsage, addOns });
  }
);

export const shouldRevalidate: ShouldRevalidateFunction = ({
  currentUrl,
  nextUrl,
  formMethod,
  defaultShouldRevalidate,
}) => {
  if (formMethod) return defaultShouldRevalidate;
  return shouldReloadUsage(currentUrl, nextUrl) ?? defaultShouldRevalidate;
};

export default function BillingUsagePage() {
  const { months, month, usage, projectUsage, addOns } = useTypedLoaderData<typeof loader>();
  const organization = useOrganization();
  const currentPlan = useCurrentPlan();
  const billingLimit = useBillingLimit();
  const plan = currentPlan?.v3Subscription?.plan;
  const includedUsageCents = plan?.limits.includedUsage ?? 0;

  return (
    <PageContainer>
      <NavBar>
        <PageTitle title="Usage" />
      </NavBar>
      <BillingUsageView
        organizationSlug={organization.slug}
        months={months}
        month={month}
        usage={usage}
        projectUsage={projectUsage}
        addOns={addOns}
        limits={{
          includedUsageDollars: plan?.type === "enterprise" ? undefined : includedUsageCents / 100,
          billingLimitDollars: getUsageBarBillingLimitDollars(billingLimit, includedUsageCents),
          hasBillingLimit:
            billingLimit !== undefined &&
            billingLimit.isConfigured &&
            billingLimit.mode === "custom",
          billingLimitsPath: v3BillingLimitsPath(organization),
        }}
      />
    </PageContainer>
  );
}
