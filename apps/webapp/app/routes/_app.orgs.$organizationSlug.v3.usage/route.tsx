import { LoaderFunctionArgs } from "@remix-run/server-runtime";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Label,
  Legend,
  Rectangle,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { redirect, typedjson, useTypedLoaderData } from "remix-typedjson";
import { PageBody, PageContainer } from "~/components/layout/AppLayout";
import { Header3 } from "~/components/primitives/Headers";
import { NavBar, PageTitle } from "~/components/primitives/PageHeader";
import { prisma } from "~/db.server";
import { featuresForRequest } from "~/features.server";
import { getUsageSeries } from "~/services/platform.v3.server";
import { requireUserId } from "~/services/session.server";
import { createTimeSeriesData } from "~/utils/graphs";
import { OrganizationParamsSchema, organizationPath } from "~/utils/pathBuilder";

export async function loader({ params, request }: LoaderFunctionArgs) {
  await requireUserId(request);
  const { organizationSlug } = OrganizationParamsSchema.parse(params);

  const { isManagedCloud } = featuresForRequest(request);
  if (!isManagedCloud) {
    return redirect(organizationPath({ slug: organizationSlug }));
  }

  const organization = await prisma.organization.findUnique({
    where: { slug: organizationSlug },
  });

  if (!organization) {
    throw new Response(null, { status: 404, statusText: "Organization not found" });
  }

  //periods
  const periodStart = new Date();
  periodStart.setDate(periodStart.getDate() - 30);
  periodStart.setHours(0, 0, 0, 0);
  const periodEnd = new Date();
  periodEnd.setDate(periodEnd.getDate() + 1);
  periodEnd.setHours(23, 59, 59, 999);

  const creditUsage = await getUsageSeries(organization.id, {
    from: periodStart,
    to: periodEnd,
    window: "DAY",
  });

  console.log(JSON.stringify(creditUsage, null, 2));

  return typedjson({
    periodStart,
    periodEnd,
    creditUsage: creditUsage
      ? createTimeSeriesData({
          startDate: periodStart,
          endDate: periodEnd,
          window: "DAY",
          data:
            creditUsage.data.map((period) => ({
              date: new Date(period.windowStart),
              value: period.value,
            })) ?? [],
        }).map((period) => ({
          date: period.date,
          dollars: (period.value ?? 0) / 100,
        }))
      : [],
  });
}

const dateFormatter = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
});

const tooltipStyle = {
  display: "flex",
  alignItems: "center",
  gap: "0.5rem",
  borderRadius: "0.25rem",
  border: "1px solid #1A2434",
  backgroundColor: "#0B1018",
  padding: "0.3rem 0.5rem",
  fontSize: "0.75rem",
  color: "#E2E8F0",
};

export default function ChoosePlanPage() {
  const { periodStart, periodEnd, creditUsage } = useTypedLoaderData<typeof loader>();

  return (
    <PageContainer>
      <NavBar>
        <PageTitle title="Usage" />
      </NavBar>
      <PageBody scrollable={true}>
        <div className="rounded-sm border border-grid-dimmed p-3">
          <Header3>Usage (past 30 days)</Header3>
          <ResponsiveContainer width="100%" height="100%" className="min-h-96">
            <BarChart
              data={creditUsage}
              margin={{
                top: 20,
                right: 0,
                left: 0,
                bottom: 10,
              }}
            >
              <XAxis
                stroke="#5F6570"
                fontSize={12}
                tickLine={false}
                axisLine={true}
                dataKey={(item: { date: Date }) => {
                  if (!item.date) return "";
                  const date = new Date(item.date);
                  if (date.getDate() === 1) {
                    return dateFormatter.format(date);
                  }
                  return `${date.getDate()}`;
                }}
                className="text-xs"
              />
              <YAxis
                stroke="#5F6570"
                fontSize={12}
                tickLine={false}
                axisLine={true}
                allowDecimals={true}
                tickFormatter={(value) => `$${value.toFixed(2)}`}
              />
              <Tooltip
                cursor={{ fill: "rgba(255,255,255,0.05)" }}
                contentStyle={tooltipStyle}
                labelFormatter={(value, data) => {
                  const dateString = data.at(0)?.payload.date;
                  if (!dateString) {
                    return "";
                  }

                  return dateFormatter.format(new Date(dateString));
                }}
              />
              <Bar dataKey="dollars" fill="#28BF5C" activeBar={<Rectangle fill="#5ADE87" />} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </PageBody>
    </PageContainer>
  );
}
