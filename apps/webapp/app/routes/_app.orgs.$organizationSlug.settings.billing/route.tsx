import { CalendarDaysIcon, CreditCardIcon, StarIcon } from "@heroicons/react/20/solid";
import { type PlanDefinition } from "@trigger.dev/platform";
import { redirect, typedjson, useTypedLoaderData } from "remix-typedjson";
import { Feedback } from "~/components/Feedback";
import { MainCenteredContainer, PageBody, PageContainer } from "~/components/layout/AppLayout";
import { Button, LinkButton } from "~/components/primitives/Buttons";
import { Callout } from "~/components/primitives/Callout";
import { DateTime } from "~/components/primitives/DateTime";
import { InfoPanel } from "~/components/primitives/InfoPanel";
import { NavBar, PageAccessories, PageTitle } from "~/components/primitives/PageHeader";
import { Paragraph } from "~/components/primitives/Paragraph";
import { prisma } from "~/db.server";
import { featuresForRequest } from "~/features.server";
import { useAutoRevalidate } from "~/hooks/useAutoRevalidate";
import { resolveOrgIdFromSlug } from "~/models/organization.server";
import { getBillingPagePlan, getPlans } from "~/services/platform.v3.server";
import { dashboardLoader } from "~/services/routeBuilders/dashboardBuilder";
import {
  OrganizationParamsSchema,
  organizationPath,
  v3StripePortalPath,
} from "~/utils/pathBuilder";
import { downgradeTakesEffectAt } from "~/components/billing/freePlanLabel";
import { PricingPlans } from "../resources.orgs.$organizationSlug.select-plan";
import { billingMessageFromKey } from "~/utils/billingMessages";
import { pageMeta } from "~/utils/pageTitle";
import { type PlanProvisioningStatus } from "~/v3/services/planProvisioningStatus.server";
import { getPlanProvisioningStatus } from "~/v3/services/planProvisioningStatusInstance.server";

export const meta = pageMeta("Billing");

export const loader = dashboardLoader(
  {
    params: OrganizationParamsSchema,
    context: async (params) => {
      const organizationId = await resolveOrgIdFromSlug(params.organizationSlug);
      return organizationId ? { organizationId } : {};
    },
    authorization: {
      action: "manage",
      resource: { type: "billing" },
      message: "With your current role, you can't manage billing.",
    },
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

    const planRead = await getBillingPagePlan(organization.id);
    if (planRead.isErr()) {
      return typedjson({ billingUnavailable: true as const, organizationSlug });
    }
    const currentPlan = planRead.value;
    const showSelfServe = currentPlan?.v3Subscription?.showSelfServe !== false;
    const billingMovesAt = billingMovesAtOf(currentPlan?.subscription);

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

    const url = new URL(request.url);
    const message = billingMessageFromKey(url.searchParams.get("message"));

    if (!showSelfServe) {
      return typedjson({
        billingUnavailable: false as const,
        showSelfServe: false as const,
        ...currentPlan,
        organizationSlug,
        periodStart,
        periodEnd,
        daysRemaining,
        message,
        billingMovesAt,
      });
    }

    const [plans, planProvisioning] = await Promise.all([
      getPlans(),
      getPlanProvisioningStatus(organization.id),
    ]);
    if (!plans) {
      throw new Response(null, { status: 404, statusText: "Plans not found" });
    }

    return typedjson({
      billingUnavailable: false as const,
      showSelfServe: true as const,
      ...plans,
      ...currentPlan,
      organizationSlug,
      periodStart,
      periodEnd,
      daysRemaining,
      message,
      planProvisioning,
      billingMovesAt,
    });
  }
);

export default function ChoosePlanPage() {
  const loaderData = useTypedLoaderData<typeof loader>();

  if (loaderData.billingUnavailable) {
    return (
      <PageContainer>
        <NavBar>
          <PageTitle title="Billing" />
        </NavBar>
        <PageBody>
          <MainCenteredContainer className="max-w-md">
            <BillingUnavailablePanel />
          </MainCenteredContainer>
        </PageBody>
      </PageContainer>
    );
  }

  const {
    showSelfServe,
    v3Subscription,
    organizationSlug,
    periodStart,
    periodEnd,
    daysRemaining,
    message,
    billingMovesAt,
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
            <PlanProvisioningCallout status={loaderData.planProvisioning} />
            {billingMovesAt && (
              <Callout variant="info">
                Billing for this organization moves on{" "}
                <DateTime includeTime={false} date={billingMovesAt} timeZone="UTC" />.
              </Callout>
            )}
            {message && (
              <Callout variant="idea" className="mb-2">
                {message}
              </Callout>
            )}
            <div className="flex flex-col gap-y-3 divide-grid-bright rounded-sm border border-grid-bright bg-background-bright py-2 pr-1 text-text-bright lg:w-fit lg:flex-row lg:items-center lg:divide-x">
              <div className="flex gap-2 px-3 lg:items-center">
                <StarIcon className="size-5 min-w-5 lg:-mt-0.5" />
                {planLabel(v3Subscription?.plan, v3Subscription?.canceledAt !== undefined)}
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

/** Shown instead of the plan and plan picker while billing can't read the org's plan. */
export function BillingUnavailablePanel() {
  return (
    <InfoPanel
      title="Billing"
      icon={CreditCardIcon}
      iconClassName="text-amber-500"
      panelClassName="max-w-full"
    >
      <Paragraph variant="small">Billing is temporarily unavailable, try again shortly.</Paragraph>
    </InfoPanel>
  );
}

function PlanProvisioningCallout({ status }: { status?: PlanProvisioningStatus }) {
  useAutoRevalidate({ interval: 3000, disabled: status !== "pending" });

  switch (status) {
    case "pending":
      return (
        <Callout variant="pending">
          We're applying your new plan. This usually takes a few seconds.
        </Callout>
      );
    case "succeeded":
      return (
        <Callout variant="success">
          Your new plan is active. Your new limits can take a minute to apply everywhere.
        </Callout>
      );
    case "failed":
      return (
        <Callout
          variant="error"
          cta={
            <Feedback
              defaultValue="help"
              button={<Button variant="secondary/small">Contact support</Button>}
            />
          }
        >
          We couldn't finish applying your new plan. Please contact support and we'll sort it out.
        </Callout>
      );
    default:
      return null;
  }
}

// Billing sends it in the subscription field, which the platform schema passes through untouched.
function billingMovesAtOf(subscription: unknown): Date | undefined {
  if (typeof subscription !== "object" || subscription === null) return undefined;
  const movesAt = (subscription as { billingMovesAt?: unknown }).billingMovesAt;
  return typeof movesAt === "string" ? new Date(movesAt) : undefined;
}

function planLabel(plan: PlanDefinition | undefined, canceled: boolean) {
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
        {text}. From <DateTime includeTime={false} date={downgradeTakesEffectAt()} timeZone="UTC" />{" "}
        you're on the Free plan.
      </>
    );
  }

  return text;
}
