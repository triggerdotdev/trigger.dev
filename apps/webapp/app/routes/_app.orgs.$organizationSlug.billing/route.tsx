import { CalendarDaysIcon, ReceiptRefundIcon } from "@heroicons/react/20/solid";
import { ArrowUpCircleIcon } from "@heroicons/react/24/outline";
import { Outlet } from "@remix-run/react";
import { ActiveSubscription } from "@trigger.dev/billing";
import { PageBody, PageContainer } from "~/components/layout/AppLayout";
import { BreadcrumbLink } from "~/components/navigation/Breadcrumb";
import { LinkButton } from "~/components/primitives/Buttons";
import { DateTime } from "~/components/primitives/DateTime";
import {
  PageButtons,
  PageHeader,
  PageInfoGroup,
  PageInfoProperty,
  PageInfoRow,
  PageTabs,
  PageTitle,
  PageTitleRow,
} from "~/components/primitives/PageHeader";
import { useFeatures } from "~/hooks/useFeatures";
import { useOrganization } from "~/hooks/useOrganizations";
import { Handle } from "~/utils/handle";
import { plansPath, stripePortalPath, usagePath } from "~/utils/pathBuilder";
import { useCurrentPlan } from "../_app.orgs.$organizationSlug/route";
import { formatDurationInDays } from "@trigger.dev/core/v3";

export const handle: Handle = {
  breadcrumb: (match) => <BreadcrumbLink to={match.pathname} title="Usage & Billing" />,
};

function planLabel(subscription: ActiveSubscription | undefined, periodEnd: Date) {
  if (!subscription) {
    return "You're currently on the Free plan";
  }
  if (!subscription.isPaying) {
    return `You're currently on the ${subscription.plan.title} plan`;
  }
  const costDescription = subscription.plan.concurrentRuns.pricing
    ? `\$${subscription.plan.concurrentRuns.pricing?.tierCost}/mo`
    : "";
  if (subscription.canceledAt) {
    return (
      <>
        You're on the {costDescription} {subscription.plan.title} plan until{" "}
        <DateTime includeTime={false} date={periodEnd} /> when you'll be on the Free plan
      </>
    );
  }

  return `You're currently on the ${costDescription} ${subscription.plan.title} plan`;
}

export default function Page() {
  const organization = useOrganization();
  const { isManagedCloud } = useFeatures();
  const currentPlan = useCurrentPlan();

  return (
    <PageContainer>
      <PageHeader hideBorder>
        <PageTitleRow>
          <PageTitle title={isManagedCloud ? "Usage & Billing" : "Usage"} />
          <PageButtons>
            {isManagedCloud && (
              <>
                {currentPlan?.subscription?.isPaying && (
                  <>
                    <LinkButton to={stripePortalPath(organization)} variant="secondary/small">
                      Invoices
                    </LinkButton>
                    <LinkButton to={stripePortalPath(organization)} variant="secondary/small">
                      Manage card details
                    </LinkButton>
                  </>
                )}
                <LinkButton
                  to={plansPath(organization)}
                  variant="primary/small"
                  LeadingIcon={ArrowUpCircleIcon}
                  leadingIconClassName="px-0"
                >
                  Upgrade
                </LinkButton>
              </>
            )}
          </PageButtons>
        </PageTitleRow>

        <PageInfoRow>
          <PageInfoGroup>
            {currentPlan?.subscription && (
              <PageInfoProperty
                icon={<ReceiptRefundIcon className="h-4 w-4 text-green-600" />}
                value={planLabel(currentPlan.subscription, currentPlan.usage.periodEnd)}
              />
            )}
            {currentPlan?.subscription?.isPaying && (
              <PageInfoProperty
                icon={<CalendarDaysIcon className="h-4 w-4 text-green-600" />}
                label={"Billing period"}
                value={
                  <>
                    <DateTime date={currentPlan.usage.periodStart} includeTime={false} /> to{" "}
                    <DateTime date={currentPlan.usage.periodEnd} includeTime={false} /> (
                    {formatDurationInDays(currentPlan.usage.periodRemainingDuration)} remaining)
                  </>
                }
              />
            )}
          </PageInfoGroup>
        </PageInfoRow>
        {isManagedCloud && (
          <PageTabs
            tabs={[
              {
                label: "Usage",
                to: usagePath(organization),
              },
              {
                label: "Plans",
                to: plansPath(organization),
              },
            ]}
            layoutId="usage-and-billing"
          />
        )}
      </PageHeader>
      <PageBody scrollable={false}>
        <div className="h-full overflow-y-auto p-4 scrollbar-thin scrollbar-track-transparent scrollbar-thumb-slate-700">
          <Outlet />
        </div>
      </PageBody>
    </PageContainer>
  );
}
