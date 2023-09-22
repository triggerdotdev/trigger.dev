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
import { organizationTeamPath } from "~/utils/pathBuilder";
import { OrgAdminHeader } from "../_app.orgs.$organizationSlug._index/OrgAdminHeader";
import { Link } from "@remix-run/react/dist/components";

const data = [
  {
    name: "Jan",
    total: Math.floor(Math.random() * 5000) + 1000,
  },
  {
    name: "Feb",
    total: Math.floor(Math.random() * 5000) + 1000,
  },
  {
    name: "Mar",
    total: Math.floor(Math.random() * 5000) + 1000,
  },
  {
    name: "Apr",
    total: Math.floor(Math.random() * 5000) + 1000,
  },
  {
    name: "May",
    total: Math.floor(Math.random() * 5000) + 1000,
  },
  {
    name: "Jun",
    total: Math.floor(Math.random() * 5000) + 1000,
  },
  {
    name: "Jul",
    total: Math.floor(Math.random() * 5000) + 1000,
  },
  {
    name: "Aug",
    total: Math.floor(Math.random() * 5000) + 1000,
  },
  {
    name: "Sep",
    total: Math.floor(Math.random() * 5000) + 1000,
  },
  {
    name: "Oct",
    total: Math.floor(Math.random() * 5000) + 1000,
  },
  {
    name: "Nov",
    total: Math.floor(Math.random() * 5000) + 1000,
  },
  {
    name: "Dec",
    total: Math.floor(Math.random() * 5000) + 1000,
  },
];

type MonthlyUsage = {
  name: string;
  total: number;
};

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

  return (
    <PageContainer>
      <OrgAdminHeader />
      <PageBody>
        <div className="mb-4 grid gap-4 md:grid-cols-2 lg:grid-cols-4">
          <div className="rounded border border-border p-6">
            <div className="flex flex-row items-center justify-between space-y-0 pb-2">
              <Header2>Total Runs this month</Header2>
              <ForwardIcon className="h-6 w-6 text-dimmed" />
            </div>
            <div>
              <p className="text-3xl font-bold">25,056</p>
              <Paragraph variant="small" className="text-dimmed">
                +20.1% from last month
              </Paragraph>
            </div>
          </div>
          <div className="rounded border border-border p-6">
            <div className="flex flex-row items-center justify-between space-y-0 pb-2">
              <Header2>Total Jobs</Header2>
              <WrenchScrewdriverIcon className="h-6 w-6 text-dimmed" />
            </div>
            <div>
              <p className="text-3xl font-bold">9</p>
              <Paragraph variant="small" className="text-dimmed">
                +2 since last month
              </Paragraph>
            </div>
          </div>
          <div className="rounded border border-border p-6">
            <div className="flex flex-row items-center justify-between space-y-0 pb-2">
              <Header2>Total Integrations</Header2>
              <SquaresPlusIcon className="h-6 w-6 text-dimmed" />
            </div>
            <div>
              <p className="text-3xl font-bold">6</p>
              <Paragraph variant="small" className="text-dimmed">
                No change since last month
              </Paragraph>
            </div>
          </div>
          <div className="rounded border border-border p-6">
            <div className="flex flex-row items-center justify-between space-y-0 pb-2">
              <Header2>Team members</Header2>
              <UsersIcon className="h-6 w-6 text-dimmed" />
            </div>
            <div>
              <p className="text-3xl font-bold">4</p>
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
              <BarChart data={data}>
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
          <div className="w-1/2 overflow-y-auto rounded border border-border px-3 py-6">
            <div className="mb-2 flex items-baseline justify-between border-b border-border px-3 pb-4">
              <Header2 className="">Jobs</Header2>
              <Header2 className="">Runs</Header2>
            </div>
            <div className="space-y-2">
              <Link
                to=""
                className="flex items-center rounded px-4 py-3 transition hover:bg-slate-850"
              >
                <div className="space-y-1">
                  <p className="text-sm font-medium leading-none">My big Job 1</p>
                  <p className="text-sm text-muted-foreground">My big Project</p>
                </div>
                <div className="ml-auto font-medium">567</div>
              </Link>
              <Link
                to=""
                className="flex items-center rounded px-4 py-3 transition hover:bg-slate-850"
              >
                <div className="space-y-1">
                  <p className="text-sm font-medium leading-none">My big Job 1</p>
                  <p className="text-sm text-muted-foreground">My big Project</p>
                </div>
                <p className="ml-auto font-medium">567</p>
              </Link>
              <Link
                to=""
                className="flex items-center rounded px-4 py-3 transition hover:bg-slate-850"
              >
                <div className="space-y-1">
                  <p className="text-sm font-medium leading-none">My big Job 1</p>
                  <p className="text-sm text-muted-foreground">My big Project</p>
                </div>
                <p className="ml-auto font-medium">567</p>
              </Link>
              <Link
                to=""
                className="flex items-center rounded px-4 py-3 transition hover:bg-slate-850"
              >
                <div className="space-y-1">
                  <p className="text-sm font-medium leading-none">My big Job 1</p>
                  <p className="text-sm text-muted-foreground">My big Project</p>
                </div>
                <p className="ml-auto font-medium">567</p>
              </Link>
              <Link
                to=""
                className="flex items-center rounded px-4 py-3 transition hover:bg-slate-850"
              >
                <div className="space-y-1">
                  <p className="text-sm font-medium leading-none">My big Job 1</p>
                  <p className="text-sm text-muted-foreground">My big Project</p>
                </div>
                <p className="ml-auto font-medium">567</p>
              </Link>
              <Link
                to=""
                className="flex items-center rounded px-4 py-3 transition hover:bg-slate-850"
              >
                <div className="space-y-1">
                  <p className="text-sm font-medium leading-none">My big Job 1</p>
                  <p className="text-sm text-muted-foreground">My big Project</p>
                </div>
                <p className="ml-auto font-medium">567</p>
              </Link>
              <Link
                to=""
                className="flex items-center rounded px-4 py-3 transition hover:bg-slate-850"
              >
                <div className="space-y-1">
                  <p className="text-sm font-medium leading-none">My big Job 1</p>
                  <p className="text-sm text-muted-foreground">My big Project</p>
                </div>
                <p className="ml-auto font-medium">567</p>
              </Link>
            </div>
          </div>
        </div>
      </PageBody>
    </PageContainer>
  );
}
