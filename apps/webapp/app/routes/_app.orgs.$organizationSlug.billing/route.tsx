import { ArrowRightIcon } from "@heroicons/react/20/solid";
import {
  ForwardIcon,
  SquaresPlusIcon,
  UsersIcon,
  WrenchScrewdriverIcon,
} from "@heroicons/react/24/solid";
import { Bar, BarChart, ResponsiveContainer, Tooltip, TooltipProps, XAxis, YAxis } from "recharts";
import { PageBody, PageContainer } from "~/components/layout/AppLayout";
import { Header2 } from "~/components/primitives/Headers";
import { Paragraph } from "~/components/primitives/Paragraph";
import { TextLink } from "~/components/primitives/TextLink";
import { useOrganization } from "~/hooks/useOrganizations";
import {
  OrganizationParamsSchema,
  PlansPath,
  UsagePath,
  jobPath,
  newProjectPath,
  organizationTeamPath,
} from "~/utils/pathBuilder";
import { Link } from "@remix-run/react/dist/components";
import { LoaderFunctionArgs } from "@remix-run/server-runtime";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { OrgUsagePresenter } from "~/presenters/OrgUsagePresenter.server";
import { requireUserId } from "~/services/session.server";
import { LinkButton } from "~/components/primitives/Buttons";
import {
  PageHeader,
  PageTitleRow,
  PageTitle,
  PageButtons,
  PageDescription,
  PageTabs,
} from "~/components/primitives/PageHeader";
import { Handle } from "~/utils/handle";
import { BreadcrumbLink } from "~/components/navigation/Breadcrumb";
import { ArrowUpCircleIcon } from "@heroicons/react/24/outline";
import { Outlet } from "@remix-run/react";

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

const CustomTooltip = ({ active, payload, label }: TooltipProps<number, string>) => {
  if (active && payload) {
    return (
      <div className="flex items-center gap-2 rounded border border-border bg-slate-900 px-4 py-2 text-sm text-dimmed">
        <p className="text-white">{label}:</p>
        <p className="text-white">{payload[0].value}</p>
      </div>
    );
  }

  return null;
};

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
        <PageDescription>Current bill total: $0.00</PageDescription>
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
