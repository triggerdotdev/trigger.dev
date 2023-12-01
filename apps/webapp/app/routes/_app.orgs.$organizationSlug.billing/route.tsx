import { ArrowUpCircleIcon } from "@heroicons/react/24/outline";
import { CalendarDaysIcon, ReceiptRefundIcon } from "@heroicons/react/24/solid";
import { Outlet } from "@remix-run/react";
import { LoaderFunctionArgs } from "@remix-run/server-runtime";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { PageBody, PageContainer } from "~/components/layout/AppLayout";
import { BreadcrumbLink } from "~/components/navigation/Breadcrumb";
import { LinkButton } from "~/components/primitives/Buttons";
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
import { useOrganization } from "~/hooks/useOrganizations";
import { OrgUsagePresenter } from "~/presenters/OrgUsagePresenter.server";
import { requireUserId } from "~/services/session.server";
import { Handle } from "~/utils/handle";
import { OrganizationParamsSchema, PlansPath, UsagePath } from "~/utils/pathBuilder";
import { useCurrentPlan } from "../_app.orgs.$organizationSlug/route";
import { useFeatures } from "~/hooks/useFeatures";
import { DateTime } from "~/components/primitives/DateTime";
import { formatDuration, formatDurationMilliseconds } from "~/utils";
import { featuresForRequest } from "~/features.server";
import { BillingPresenter } from "~/presenters/BillingPresenter.server";

export async function loader({ params, request }: LoaderFunctionArgs) {
  const userId = await requireUserId(request);
  const { organizationSlug } = OrganizationParamsSchema.parse(params);

  const presenter = new OrgUsagePresenter();
  const data = await presenter.call({ userId, slug: organizationSlug });

  if (!data) {
    throw new Response(null, { status: 404 });
  }

  const { isManagedCloud } = featuresForRequest(request);
  const billingPresenter = new BillingPresenter(isManagedCloud);
  const portal = await billingPresenter.customerPortalUrl(data.id, organizationSlug);
  const stripePortalLink = portal?.success ? portal?.customerPortalUrl : undefined;

  return typedjson({ ...data, stripePortalLink });
}

export const handle: Handle = {
  breadcrumb: (match) => <BreadcrumbLink to={match.pathname} title="Usage & Billing" />,
};

export default function Page() {
  const { stripePortalLink } = useTypedLoaderData<typeof loader>();
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
                {stripePortalLink && (
                  <>
                    <LinkButton to={stripePortalLink} variant="secondary/small">
                      Invoices
                    </LinkButton>
                    <LinkButton to={stripePortalLink} variant="secondary/small">
                      Manage card details
                    </LinkButton>
                  </>
                )}
                <LinkButton
                  to={PlansPath(organization)}
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
                value={`You're currently on the${
                  currentPlan.subscription.plan.concurrentRuns.pricing?.tierCost
                    ? ` \$${currentPlan.subscription.plan.concurrentRuns.pricing?.tierCost}/mo`
                    : ""
                } ${currentPlan.subscription?.plan.title} plan`}
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
                    {formatDurationMilliseconds(currentPlan.usage.periodRemainingDuration, {
                      style: "short",
                    })}{" "}
                    remaining)
                  </>
                }
              />
            )}
          </PageInfoGroup>
        </PageInfoRow>
        <PageTabs
          tabs={[
            {
              label: "Usage & Billing",
              to: UsagePath(organization),
            },
            {
              label: "Plans",
              to: PlansPath(organization),
            },
          ]}
          layoutId="usage-and-billing"
        />
      </PageHeader>
      <PageBody scrollable={false}>
        <div className="h-full overflow-y-auto p-4 scrollbar-thin scrollbar-track-transparent scrollbar-thumb-slate-700">
          <Outlet />
        </div>
      </PageBody>
    </PageContainer>
  );
}
