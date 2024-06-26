import { LoaderFunctionArgs } from "@remix-run/server-runtime";
import { redirect, typedjson, useTypedLoaderData } from "remix-typedjson";
import { PageBody, PageContainer } from "~/components/layout/AppLayout";
import { LinkButton } from "~/components/primitives/Buttons";
import { NavBar, PageAccessories, PageTitle } from "~/components/primitives/PageHeader";
import { prisma } from "~/db.server";
import { featuresForRequest } from "~/features.server";
import { BillingService } from "~/services/billing.v3.server";
import { requireUserId } from "~/services/session.server";
import {
  OrganizationParamsSchema,
  organizationPath,
  v3StripePortalPath,
} from "~/utils/pathBuilder";
import { PricingPlans } from "../resources.orgs.$organizationSlug.select-plan";
import { PlanDefinition } from "@trigger.dev/billing/v3";
import { CalendarDaysIcon, StarIcon } from "@heroicons/react/20/solid";
import { DateTime } from "~/components/primitives/DateTime";

export async function loader({ params, request }: LoaderFunctionArgs) {
  await requireUserId(request);
  const { organizationSlug } = OrganizationParamsSchema.parse(params);

  const { isManagedCloud } = featuresForRequest(request);
  if (!isManagedCloud) {
    return redirect(organizationPath({ slug: organizationSlug }));
  }

  const billingPresenter = new BillingService(isManagedCloud);
  const plans = await billingPresenter.getPlans();
  if (!plans) {
    throw new Response(null, { status: 404, statusText: "Plans not found" });
  }

  const organization = await prisma.organization.findUnique({
    where: { slug: organizationSlug },
  });

  if (!organization) {
    throw new Response(null, { status: 404, statusText: "Organization not found" });
  }

  const currentPlan = await billingPresenter.currentPlan(organization.id);

  //periods
  const periodStart = new Date();
  periodStart.setHours(0, 0, 0, 0);
  periodStart.setDate(1);

  const periodEnd = new Date();
  periodEnd.setMonth(periodEnd.getMonth() + 1);
  periodEnd.setDate(0);
  periodEnd.setHours(0, 0, 0, 0);

  const daysRemaining = Math.ceil(
    (periodEnd.getTime() - new Date().getTime()) / (1000 * 60 * 60 * 24)
  );

  return typedjson({
    ...plans,
    ...currentPlan,
    organizationSlug,
    periodStart,
    periodEnd,
    daysRemaining,
  });
}

export default function ChoosePlanPage() {
  const { plans, v3Subscription, organizationSlug, periodStart, periodEnd, daysRemaining } =
    useTypedLoaderData<typeof loader>();
  return (
    <PageContainer>
      <NavBar>
        <PageTitle title="Billing" />
        <PageAccessories>
          {v3Subscription?.isPaying && (
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
      <PageBody scrollable={true}>
        <div className="flex flex-col gap-3 px-3 py-2">
          <div className="flex items-center  divide-x divide-grid-dimmed rounded-sm border border-grid-dimmed py-2 text-text-bright">
            <div className="flex items-center gap-1 px-3">
              <StarIcon className="size-5 " />
              {planLabel(v3Subscription?.plan, v3Subscription?.canceledAt !== undefined, periodEnd)}
            </div>
            <div className="flex items-center gap-1 px-3">
              <CalendarDaysIcon className="size-5" />
              Billing period: <DateTime date={periodStart} includeTime={false} /> to{" "}
              <DateTime date={periodEnd} includeTime={false} /> ({daysRemaining} days remaining)
            </div>
          </div>
          <div>
            <PricingPlans
              plans={plans}
              subscription={v3Subscription}
              organizationSlug={organizationSlug}
            />
          </div>
        </div>
      </PageBody>
    </PageContainer>
  );
}

function planLabel(plan: PlanDefinition | undefined, canceled: boolean, periodEnd: Date) {
  if (!plan || plan.type === "free") {
    return "You're on the Free plan";
  }

  if (plan.type === "enterprise") {
    return `You're on the Enterprise plan`;
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
