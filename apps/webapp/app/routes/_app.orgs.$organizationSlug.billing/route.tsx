import { ArrowUpCircleIcon } from "@heroicons/react/24/outline";
import { CalendarDaysIcon, GiftIcon, ReceiptRefundIcon } from "@heroicons/react/24/solid";
import { Outlet } from "@remix-run/react";
import { LoaderFunctionArgs } from "@remix-run/server-runtime";
import { typedjson } from "remix-typedjson";
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

export async function loader({ params, request }: LoaderFunctionArgs) {
  const userId = await requireUserId(request);
  const { organizationSlug } = OrganizationParamsSchema.parse(params);

  const presenter = new OrgUsagePresenter();

  const data = await presenter.call({ userId, slug: organizationSlug });

  if (!data) {
    throw new Response(null, { status: 404 });
  }

  return typedjson(data);
}

export const handle: Handle = {
  breadcrumb: (match) => <BreadcrumbLink to={match.pathname} title="Usage & Billing" />,
};

export default function Page() {
  const organization = useOrganization();

  return (
    <PageContainer>
      <PageHeader hideBorder>
        <PageTitleRow>
          <PageTitle title="Usage & Billing" />
          <PageButtons>
            <LinkButton to={""} variant="secondary/small">
              Invoices
            </LinkButton>
            <LinkButton to={""} variant="secondary/small">
              Manage card details
            </LinkButton>
            <LinkButton
              to={PlansPath(organization)}
              variant="primary/small"
              LeadingIcon={ArrowUpCircleIcon}
              leadingIconClassName="px-0"
            >
              Upgrade
            </LinkButton>
          </PageButtons>
        </PageTitleRow>

        <PageInfoRow>
          <PageInfoGroup>
            <PageInfoProperty
              icon={<ReceiptRefundIcon className="h-4 w-4 text-green-600" />}
              label={"Current Bill Total"}
              value={"$0.00"}
            />
            <PageInfoProperty
              icon={<GiftIcon className="h-4 w-4 text-green-600" />}
              value={"You’re currently on the Free plan"}
            />
            <PageInfoProperty
              icon={<CalendarDaysIcon className="h-4 w-4 text-green-600" />}
              label={"Billing period"}
              value={"Nov 2, 2023 to Dec 2, 2023 (8 days remaining)"}
            />
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
