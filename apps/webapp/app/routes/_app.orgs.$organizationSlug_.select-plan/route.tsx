import { redirect, typedjson, useTypedLoaderData } from "remix-typedjson";
import { BackgroundWrapper } from "~/components/BackgroundWrapper";
import { AppContainer, MainBody, PageBody } from "~/components/layout/AppLayout";
import { Header1 } from "~/components/primitives/Headers";
import { $replica, prisma } from "~/db.server";
import { featuresForRequest } from "~/features.server";
import { getCurrentPlan, getPlans } from "~/services/platform.v3.server";
import { dashboardLoader } from "~/services/routeBuilders/dashboardBuilder";
import { OrganizationParamsSchema, organizationPath } from "~/utils/pathBuilder";
import { PricingPlans } from "../resources.orgs.$organizationSlug.select-plan";

async function resolveOrgIdFromSlug(slug: string): Promise<string | null> {
  const org = await $replica.organization.findFirst({ where: { slug }, select: { id: true } });
  return org?.id ?? null;
}

export const loader = dashboardLoader(
  {
    params: OrganizationParamsSchema,
    context: async (params) => {
      const organizationId = await resolveOrgIdFromSlug(params.organizationSlug);
      return organizationId ? { organizationId } : {};
    },
    authorization: { action: "manage", resource: { type: "billing" } },
  },
  async ({ params, request }) => {
    const { organizationSlug } = params;

    const { isManagedCloud } = featuresForRequest(request);
    if (!isManagedCloud) {
      return redirect(organizationPath({ slug: organizationSlug }));
    }

    const plans = await getPlans();
    if (!plans) {
      throw new Response(null, { status: 404, statusText: "Plans not found" });
    }

    const organization = await prisma.organization.findFirst({
      where: { slug: organizationSlug },
    });

    if (!organization) {
      throw new Response(null, { status: 404, statusText: "Organization not found" });
    }

    if (organization.v3Enabled) {
      return redirect(organizationPath({ slug: organizationSlug }));
    }

    const currentPlan = await getCurrentPlan(organization.id);

    const periodEnd = new Date();
    periodEnd.setMonth(periodEnd.getMonth() + 1);

    return typedjson({ ...plans, ...currentPlan, organizationSlug, periodEnd });
  }
);

export default function ChoosePlanPage() {
  const { plans, v3Subscription, organizationSlug, periodEnd, addOnPricing } =
    useTypedLoaderData<typeof loader>();

  return (
    <AppContainer>
      <PageBody className="bg-charcoal-900">
        <BackgroundWrapper>
          <div className="mx-auto mt-4 flex h-fit min-h-full max-w-[80rem] flex-col items-center justify-center gap-8 lg:mt-0">
            <Header1 className="text-center">Subscribe for full access</Header1>
            <div className="w-full rounded-lg border border-grid-bright bg-background-dimmed p-5 shadow-lg">
              <PricingPlans
                plans={plans}
                concurrencyAddOnPricing={addOnPricing.concurrency}
                subscription={v3Subscription}
                organizationSlug={organizationSlug}
                hasPromotedPlan
                showGithubVerificationBadge
                periodEnd={periodEnd}
              />
            </div>
          </div>
        </BackgroundWrapper>
      </PageBody>
    </AppContainer>
  );
}
