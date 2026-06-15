import { CalendarDaysIcon, CreditCardIcon, StarIcon } from "@heroicons/react/20/solid";
import { type PlanDefinition } from "@trigger.dev/platform";
import { redirect, typedjson, useTypedLoaderData } from "remix-typedjson";
import { Feedback } from "~/components/Feedback";
import { MainCenteredContainer, PageBody, PageContainer } from "~/components/layout/AppLayout";
import { Button, LinkButton } from "~/components/primitives/Buttons";
import { DateTime } from "~/components/primitives/DateTime";
import { InfoPanel } from "~/components/primitives/InfoPanel";
import { NavBar, PageAccessories, PageTitle } from "~/components/primitives/PageHeader";
import { Paragraph } from "~/components/primitives/Paragraph";
import { $replica, prisma } from "~/db.server";
import { featuresForRequest } from "~/features.server";
import { getCurrentPlan, getPlans } from "~/services/platform.v3.server";
import { dashboardLoader } from "~/services/routeBuilders/dashboardBuilder";
import {
  OrganizationParamsSchema,
  organizationPath,
  v3StripePortalPath,
  v3UsagePath,
} from "~/utils/pathBuilder";
import { PricingPlans } from "../resources.orgs.$organizationSlug.select-plan";
import { type MetaFunction } from "@remix-run/react";
import { Callout } from "~/components/primitives/Callout";

export const meta: MetaFunction = () => {
  return [
    {
      title: `Billing | Trigger.dev`,
    },
  ];
};

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
  async ({ params, request, user }) => {
    const userId = user.id;
    const { organizationSlug } = params;

    const { isManagedCloud } = featuresForRequest(request);
    if (!isManagedCloud) {
      return redirect(organizationPath({ slug: organizationSlug }));
    }

    const organization = await prisma.organization.findFirst({
      where: { slug: organizationSlug, members: { some: { userId } } },
    });

    if (!organization) {
      throw new Response(null, { status: 404, statusText: "Organization not found" });
    }

    const currentPlan = await getCurrentPlan(organization.id);
    const showSelfServe = currentPlan?.v3Subscription?.showSelfServe !== false;

    //periods
    const periodStart = new Date();
    periodStart.setUTCHours(0, 0, 0, 0);
    periodStart.setUTCDate(1);

    const periodEnd = new Date();
    periodEnd.setUTCMonth(periodEnd.getMonth() + 1);
    periodEnd.setUTCDate(0);
    periodEnd.setUTCHours(0, 0, 0, 0);

    const daysRemaining = Math.ceil(
      (periodEnd.getTime() - new Date().getTime()) / (1000 * 60 * 60 * 24)
    );

    // Extract 'message' from search params
    const url = new URL(request.url);
    const message = url.searchParams.get("message");

    if (!showSelfServe) {
      return typedjson({
        showSelfServe: false as const,
        ...currentPlan,
        organizationSlug,
        periodStart,
        periodEnd,
        daysRemaining,
        message,
      });
    }

    const plans = await getPlans();
    if (!plans) {
      throw new Response(null, { status: 404, statusText: "Plans not found" });
    }

    return typedjson({
      showSelfServe: true as const,
      ...plans,
      ...currentPlan,
      organizationSlug,
      periodStart,
      periodEnd,
      daysRemaining,
      message,
    });
  }
);

export default function ChoosePlanPage() {
  const loaderData = useTypedLoaderData<typeof loader>();
  const {
    showSelfServe,
    v3Subscription,
    organizationSlug,
    periodStart,
    periodEnd,
    daysRemaining,
    message,
  } = loaderData;

  return (
    <PageContainer>
      <NavBar>
        <PageTitle title="Billing" />
        <PageAccessories>
          {v3Subscription?.isPaying && showSelfServe && (
            <>
              <LinkButton
                to={v3StripePortalPath({ slug: organizationSlug })}
                variant="tertiary/small"
              >
                Invoices
              </LinkButton>
              <LinkButton
                to={v3StripePortalPath({ slug: organizationSlug })}
                variant="tertiary/small"
              >
                Manage card details
              </LinkButton>
            </>
          )}
        </PageAccessories>
      </NavBar>
      <PageBody scrollable={showSelfServe}>
        {showSelfServe ? (
          <div className="flex flex-col gap-3">
            {message && (
              <Callout variant="idea" className="mb-2">
                {message}
              </Callout>
            )}
            <div className="flex flex-col gap-y-3 divide-grid-bright rounded-sm border border-grid-bright bg-background-bright py-2 pr-1 text-text-bright lg:w-fit lg:flex-row lg:items-center lg:divide-x">
              <div className="flex gap-2 px-3 lg:items-center">
                <StarIcon className="size-5 min-w-5 lg:-mt-0.5" />
                {planLabel(
                  v3Subscription?.plan,
                  v3Subscription?.canceledAt !== undefined,
                  periodEnd
                )}
              </div>
              {v3Subscription?.isPaying ? (
                <div className="flex gap-2 px-3 lg:items-center">
                  <CalendarDaysIcon className="size-5 min-w-5 lg:-mt-0.5" />
                  Billing period: <DateTime
                    date={periodStart}
                    includeTime={false}
                    timeZone="UTC"
                  />{" "}
                  to <DateTime date={periodEnd} includeTime={false} timeZone="UTC" /> (
                  {daysRemaining} days remaining)
                </div>
              ) : null}
            </div>
            <div>
              <PricingPlans
                plans={loaderData.plans}
                concurrencyAddOnPricing={loaderData.addOnPricing.concurrency}
                subscription={v3Subscription}
                organizationSlug={organizationSlug}
                hasPromotedPlan={false}
                periodEnd={periodEnd}
              />
            </div>
          </div>
        ) : (
          <MainCenteredContainer className="max-w-md">
            <InfoPanel
              title="Billing"
              icon={CreditCardIcon}
              iconClassName="text-emerald-500"
              panelClassName="max-w-full"
              accessory={
                <Feedback
                  defaultValue="enterprise"
                  button={<Button variant="secondary/small">Contact us</Button>}
                />
              }
            >
              <Paragraph spacing variant="small">
                Your billing is managed by our team.
              </Paragraph>
              <Paragraph spacing variant="small">
                Get in touch for invoices, plan changes, or other billing questions.
              </Paragraph>
            </InfoPanel>
          </MainCenteredContainer>
        )}
      </PageBody>
    </PageContainer>
  );
}

function planLabel(plan: PlanDefinition | undefined, canceled: boolean, periodEnd: Date) {
  if (!plan || plan.type === "free") {
    return "You're on the Free plan";
  }

  if (plan.type === "enterprise") {
    return "You're on the Enterprise plan";
  }

  const text = `You're on the $${plan.tierPrice}/mo ${plan.title} plan`;

  if (canceled) {
    return (
      <>
        {text}. From <DateTime includeTime={false} date={periodEnd} /> you're on the Free plan.
      </>
    );
  }

  return text;
}
