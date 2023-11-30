import { ArrowRightIcon } from "@heroicons/react/20/solid";
import { ArrowUpCircleIcon } from "@heroicons/react/24/outline";
import { SquaresPlusIcon, UsersIcon, WrenchScrewdriverIcon } from "@heroicons/react/24/solid";
import { Link } from "@remix-run/react/dist/components";
import { LoaderFunctionArgs } from "@remix-run/server-runtime";
import { Bar, BarChart, ResponsiveContainer, Tooltip, TooltipProps, XAxis, YAxis } from "recharts";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { ConcurrentRunsChart } from "~/components/billing/ConcurrentRunsChart";
import { UsageBar } from "~/components/billing/UsageBar";
import { LinkButton } from "~/components/primitives/Buttons";
import { Callout } from "~/components/primitives/Callout";
import { Header2, Header3 } from "~/components/primitives/Headers";
import { NamedIcon } from "~/components/primitives/NamedIcon";
import { Paragraph } from "~/components/primitives/Paragraph";
import { TextLink } from "~/components/primitives/TextLink";
import { useOrganization } from "~/hooks/useOrganizations";
import { OrgUsagePresenter } from "~/presenters/OrgUsagePresenter.server";
import { requireUserId } from "~/services/session.server";
import {
  OrganizationParamsSchema,
  PlansPath,
  jobPath,
  organizationTeamPath,
} from "~/utils/pathBuilder";

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
      <div className="flex gap-1 rounded border border-border bg-background px-3 py-2 text-xs text-bright">
        <p>{label}:</p>
        <p>{payload[0].value}</p>
      </div>
    );
  }

  return null;
};

export default function Page() {
  const organization = useOrganization();
  const loaderData = useTypedLoaderData<typeof loader>();

  return (
    <div className="flex flex-col gap-4">
      <div>
        <Header2 spacing>Concurrent Runs</Header2>
        <div className="flex w-full flex-col gap-4 rounded border border-border p-6">
          <Callout
            variant={"pricing"}
            cta={
              <LinkButton
                variant="primary/small"
                LeadingIcon={ArrowUpCircleIcon}
                leadingIconClassName="px-0"
                to={PlansPath(organization)}
              >
                Increase concurrent Runs
              </LinkButton>
            }
          >
            Some of your Runs are being queued because the number of concurrent Runs is limited to
            50.
          </Callout>
          <ConcurrentRunsChart concurrentRunsLimit={25} />
        </div>
      </div>

      <div className="@container">
        <Header2 spacing>Runs</Header2>
        <div className="flex flex-col gap-8 rounded border border-border p-6 @4xl:flex-row">
          <div className="flex w-full flex-col gap-4">
            <div className="flex w-full items-center gap-6">
              <div className="flex flex-col gap-2">
                <Header3 className="">Month-to-date</Header3>
                <p className="text-3xl font-medium text-bright">$0.00</p>
              </div>
              <ArrowRightIcon className="h-6 w-6 text-dimmed/50" />
              <div className="flex flex-col gap-2 text-dimmed">
                <Header3 className="text-dimmed">Projected</Header3>
                <p className="text-3xl font-medium">$5.25</p>
              </div>
            </div>
            <UsageBar numberOfCurrentRuns={15467} tierRunLimit={10000} projectedRuns={25347} />
          </div>
          <div className="relative w-full">
            <Header3 className="mb-4">Monthly Runs</Header3>
            <Paragraph className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2">
              No Runs to show
            </Paragraph>
            <ResponsiveContainer width="100%" height={200}>
              <BarChart
                data={loaderData.chartData}
                margin={{
                  top: 0,
                  right: 0,
                  left: 0,
                  bottom: 0,
                }}
                className="-ml-7"
              >
                <XAxis
                  dataKey="name"
                  stroke="#94A3B8"
                  fontSize={12}
                  tickLine={false}
                  axisLine={false}
                />
                <YAxis
                  stroke="#94A3B8"
                  fontSize={12}
                  tickLine={false}
                  axisLine={false}
                  tickFormatter={(value) => `${value}`}
                />
                <Tooltip cursor={{ fill: "rgba(255,255,255,0.05)" }} content={<CustomTooltip />} />
                <Bar dataKey="total" fill="#16A34A" radius={[3, 3, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      </div>
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        <div className="rounded border border-border p-6">
          <div className="flex flex-row items-center justify-between space-y-0 pb-2">
            <Header3>Total Runs this month</Header3>
            <NamedIcon className="h-6 w-6 text-dimmed/50" name={"runs"} />
          </div>
          <div>
            <p className="text-3xl font-medium">{loaderData.runsCount.toLocaleString()}</p>
            <Paragraph variant="small" className="text-dimmed">
              {loaderData.runsCountLastMonth} Runs last month
            </Paragraph>
          </div>
        </div>
        <div className="rounded border border-border p-6">
          <div className="flex flex-row items-center justify-between space-y-0 pb-2">
            <Header3>Total Jobs</Header3>
            <WrenchScrewdriverIcon className="h-6 w-6 text-dimmed/50" />
          </div>
          <div>
            <p className="text-3xl font-medium">{loaderData.totalJobs.toLocaleString()}</p>
            <Paragraph variant="small" className="text-dimmed">
              {loaderData.totalJobs === loaderData.totalJobsLastMonth ? (
                <>No change since last month</>
              ) : loaderData.totalJobs > loaderData.totalJobsLastMonth ? (
                <>+{loaderData.totalJobs - loaderData.totalJobsLastMonth} since last month</>
              ) : (
                <>-{loaderData.totalJobsLastMonth - loaderData.totalJobs} since last month</>
              )}
            </Paragraph>
          </div>
        </div>
        <div className="rounded border border-border p-6">
          <div className="flex flex-row items-center justify-between space-y-0 pb-2">
            <Header3>Total Integrations</Header3>
            <SquaresPlusIcon className="h-6 w-6 text-dimmed/50" />
          </div>
          <div>
            <p className="text-3xl font-medium">{loaderData.totalIntegrations.toLocaleString()}</p>
            <Paragraph variant="small" className="text-dimmed">
              {loaderData.totalIntegrations === loaderData.totalIntegrationsLastMonth ? (
                <>No change since last month</>
              ) : loaderData.totalIntegrations > loaderData.totalIntegrationsLastMonth ? (
                <>
                  +{loaderData.totalIntegrations - loaderData.totalIntegrationsLastMonth} since last
                  month
                </>
              ) : (
                <>
                  -{loaderData.totalIntegrationsLastMonth - loaderData.totalIntegrations} since last
                  month
                </>
              )}
            </Paragraph>
          </div>
        </div>
        <div className="rounded border border-border p-6">
          <div className="flex flex-row items-center justify-between space-y-0 pb-2">
            <Header3>Team members</Header3>
            <UsersIcon className="h-6 w-6 text-dimmed/50" />
          </div>
          <div>
            <p className="text-3xl font-medium">{loaderData.totalMembers.toLocaleString()}</p>
            <TextLink
              to={organizationTeamPath(organization)}
              className="group text-sm text-dimmed hover:text-bright"
            >
              Manage
              <ArrowRightIcon className="-mb-0.5 ml-0.5 h-4 w-4 text-dimmed transition group-hover:translate-x-1 group-hover:text-bright" />
            </TextLink>
          </div>
        </div>
      </div>
    </div>
  );
}
