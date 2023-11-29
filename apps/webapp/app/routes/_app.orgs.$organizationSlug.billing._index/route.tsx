import { ArrowRightIcon } from "@heroicons/react/20/solid";
import { ArrowUpCircleIcon } from "@heroicons/react/24/outline";
import {
  ForwardIcon,
  SquaresPlusIcon,
  UsersIcon,
  WrenchScrewdriverIcon,
} from "@heroicons/react/24/solid";
import { Link } from "@remix-run/react/dist/components";
import { LoaderFunctionArgs } from "@remix-run/server-runtime";
import { Bar, BarChart, ResponsiveContainer, Tooltip, TooltipProps, XAxis, YAxis } from "recharts";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { BreadcrumbLink } from "~/components/navigation/Breadcrumb";
import { Button, LinkButton } from "~/components/primitives/Buttons";
import { Callout } from "~/components/primitives/Callout";
import { Header2 } from "~/components/primitives/Headers";
import { Paragraph } from "~/components/primitives/Paragraph";
import { TextLink } from "~/components/primitives/TextLink";
import { useOrganization } from "~/hooks/useOrganizations";
import { OrgUsagePresenter } from "~/presenters/OrgUsagePresenter.server";
import { requireUserId } from "~/services/session.server";
import { Handle } from "~/utils/handle";
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
      <div className="flex items-center gap-2 rounded border border-border bg-slate-900 px-4 py-2 text-sm text-dimmed">
        <p className="text-white">{label}:</p>
        <p className="text-white">{payload[0].value}</p>
      </div>
    );
  }

  return null;
};

export default function Page() {
  const organization = useOrganization();
  const loaderData = useTypedLoaderData<typeof loader>();

  return (
    <>
      <Callout
        variant={"pricing"}
        cta={
          <LinkButton
            variant="primary/small"
            LeadingIcon={ArrowUpCircleIcon}
            leadingIconClassName="px-0"
            to={PlansPath(organization)}
          >
            Increase concurrency
          </LinkButton>
        }
        className="mb-4"
      >
        Some of your Runs are being queued because your Run concurrency is limited to 50.
      </Callout>
      <div className="mb-4 grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        <div className="rounded border border-border p-6">
          <div className="flex flex-row items-center justify-between space-y-0 pb-2">
            <Header2>Total Runs this month</Header2>
            <ForwardIcon className="h-6 w-6 text-dimmed" />
          </div>
          <div>
            <p className="text-3xl font-bold">{loaderData.runsCount.toLocaleString()}</p>
            <Paragraph variant="small" className="text-dimmed">
              {loaderData.runsCountLastMonth} runs last month
            </Paragraph>
          </div>
        </div>
        <div className="rounded border border-border p-6">
          <div className="flex flex-row items-center justify-between space-y-0 pb-2">
            <Header2>Total Jobs</Header2>
            <WrenchScrewdriverIcon className="h-6 w-6 text-dimmed" />
          </div>
          <div>
            <p className="text-3xl font-bold">{loaderData.totalJobs.toLocaleString()}</p>
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
            <Header2>Total Integrations</Header2>
            <SquaresPlusIcon className="h-6 w-6 text-dimmed" />
          </div>
          <div>
            <p className="text-3xl font-bold">{loaderData.totalIntegrations.toLocaleString()}</p>
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
            <Header2>Team members</Header2>
            <UsersIcon className="h-6 w-6 text-dimmed" />
          </div>
          <div>
            <p className="text-3xl font-bold">{loaderData.totalMembers.toLocaleString()}</p>
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
      <div className="flex max-h-[500px] gap-x-4">
        <div className="w-1/2 rounded border border-border py-6 pr-2">
          <Header2 className="mb-8 pl-6">Job Runs per month</Header2>
          <ResponsiveContainer width="100%" height={400}>
            <BarChart data={loaderData.chartData}>
              <XAxis
                dataKey="name"
                stroke="#888888"
                fontSize={12}
                tickLine={false}
                axisLine={false}
              />
              <YAxis
                stroke="#888888"
                fontSize={12}
                tickLine={false}
                axisLine={false}
                tickFormatter={(value) => `${value}`}
              />
              <Tooltip cursor={{ fill: "rgba(255,255,255,0.05)" }} content={<CustomTooltip />} />
              <Bar dataKey="total" fill="#DB2777" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
        <div className="w-1/2 overflow-y-auto rounded border border-border px-3 py-6 scrollbar-thin scrollbar-track-transparent scrollbar-thumb-slate-700">
          <div className="mb-2 flex items-baseline justify-between border-b border-border px-3 pb-4">
            <Header2 className="">Jobs</Header2>
            <Header2 className="">Runs</Header2>
          </div>
          <div className="space-y-2">
            {loaderData.jobs.map((job) => (
              <Link
                to={jobPath(organization, job.project, job)}
                className="flex items-center rounded px-4 py-3 transition hover:bg-slate-850"
                key={job.id}
              >
                <div className="space-y-1">
                  <p className="text-sm font-medium leading-none">{job.slug}</p>
                  <p className="text-sm text-muted-foreground">Project: {job.project.name}</p>
                </div>
                <div className="ml-auto font-medium">{job._count.runs.toLocaleString()}</div>
              </Link>
            ))}
          </div>
        </div>
      </div>
    </>
  );
}
