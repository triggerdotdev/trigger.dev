import { CalendarDaysIcon, StarIcon } from "@heroicons/react/20/solid";
import { type LoaderFunctionArgs } from "@remix-run/server-runtime";
import { type PlanDefinition } from "@trigger.dev/platform";
import { redirect, typedjson, useTypedLoaderData } from "remix-typedjson";
import { PageBody, PageContainer } from "~/components/layout/AppLayout";
import { LinkButton } from "~/components/primitives/Buttons";
import { DateTime } from "~/components/primitives/DateTime";
import { NavBar, PageAccessories, PageTitle } from "~/components/primitives/PageHeader";
import { prisma } from "~/db.server";
import { featuresForRequest } from "~/features.server";
import { getCurrentPlan, getPlans } from "~/services/platform.v3.server";
import { requireUserId } from "~/services/session.server";
import {
  OrganizationParamsSchema,
  organizationPath,
  v3StripePortalPath,
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

export async function loader({ params, request }: LoaderFunctionArgs) {
  await requireUserId(request);
  const { organizationSlug } = OrganizationParamsSchema.parse(params);

  const { isManagedCloud } = featuresForRequest(request);
  if (!isManagedCloud) {
    return redirect(organizationPath({ slug: organizationSlug }));
  }

  const plans = await getPlans();
  if (!plans) {
    throw new Response(null, { status: 404, statusText: "Plans not found" });
  }

  const organization = await prisma.organization.findUnique({
    where: { slug: organizationSlug },
  });

  if (!organization) {
    throw new Response(null, { status: 404, statusText: "Organization not found" });
  }

  const currentPlan = await getCurrentPlan(organization.id);

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

  return typedjson({
    ...plans,
    ...currentPlan,
    organizationSlug,
    periodStart,
    periodEnd,
    daysRemaining,
    message,
  });
}

export default function ChoosePlanPage() {
  const {
    plans,
    v3Subscription,
    organizationSlug,
    periodStart,
    periodEnd,
    daysRemaining,
    message,
  } = useTypedLoaderData<typeof loader>();
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
        <div className="flex flex-col gap-3">
          {message && (
            <Callout variant="idea" className="mb-2">
              {message}
            </Callout>
          )}
          <div className="flex flex-col gap-y-3 divide-grid-bright rounded-sm border border-grid-bright bg-background-bright py-2 pr-1 text-text-bright lg:w-fit lg:flex-row lg:items-center lg:divide-x">
            <div className="flex gap-2 px-3 lg:items-center">
              <StarIcon className="size-5 min-w-5 lg:-mt-0.5" />
              {planLabel(v3Subscription?.plan, v3Subscription?.canceledAt !== undefined, periodEnd)}
            </div>
            {v3Subscription?.isPaying ? (
              <div className="flex gap-2 px-3 lg:items-center">
                <CalendarDaysIcon className="size-5 min-w-5 lg:-mt-0.5" />
                Billing period: <DateTime
                  date={periodStart}
                  includeTime={false}
                  timeZone="UTC"
                />{" "}
                to <DateTime date={periodEnd} includeTime={false} timeZone="UTC" /> ({daysRemaining}{" "}
                days remaining)
              </div>
            ) : null}
          </div>
          <div>
            <PricingPlans
              plans={plans}
              subscription={v3Subscription}
              organizationSlug={organizationSlug}
              hasPromotedPlan={false}
              periodEnd={periodEnd}
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
