import { InformationCircleIcon } from "@heroicons/react/20/solid";
import { Await, type MetaFunction } from "@remix-run/react";
import { type LoaderFunctionArgs } from "@remix-run/server-runtime";
import { formatDurationMilliseconds } from "@trigger.dev/core/v3";
import { Suspense } from "react";
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts";
import { redirect, typeddefer, useTypedLoaderData } from "remix-typedjson";
import { URL } from "url";
import { UsageBar } from "~/components/billing/UsageBar";
import { PageBody, PageContainer } from "~/components/layout/AppLayout";
import {
  type ChartConfig,
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from "~/components/primitives/Chart";
import { Header2 } from "~/components/primitives/Headers";
import { InfoPanel } from "~/components/primitives/InfoPanel";
import { NavBar, PageTitle } from "~/components/primitives/PageHeader";
import { Paragraph } from "~/components/primitives/Paragraph";
import { Select, SelectItem } from "~/components/primitives/Select";
import { Spinner } from "~/components/primitives/Spinner";
import {
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
} from "~/components/primitives/Table";
import { prisma } from "~/db.server";
import { featuresForRequest } from "~/features.server";
import { useSearchParams } from "~/hooks/useSearchParam";
import { UsagePresenter, type UsageSeriesData } from "~/presenters/v3/UsagePresenter.server";
import { requireUserId } from "~/services/session.server";
import { formatCurrency, formatCurrencyAccurate, formatNumber } from "~/utils/numberFormatter";
import { OrganizationParamsSchema, organizationPath } from "~/utils/pathBuilder";
import { useCurrentPlan } from "../_app.orgs.$organizationSlug/route";

export const meta: MetaFunction = () => {
  return [
    {
      title: `Usage | Trigger.dev`,
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

  const organization = await prisma.organization.findUnique({
    where: { slug: organizationSlug },
  });

  if (!organization) {
    throw new Response(null, { status: 404, statusText: "Organization not found" });
  }

  //past 6 months, 1st day of the month
  const months = Array.from({ length: 6 }, (_, i) => {
    const date = new Date();
    date.setUTCDate(1);
    date.setUTCMonth(date.getUTCMonth() - i);
    date.setUTCHours(0, 0, 0, 0);
    return date;
  });

  const search = new URL(request.url).searchParams;
  const searchMonth = search.get("month");
  const startDate = searchMonth ? new Date(decodeURIComponent(searchMonth)) : months[0];
  startDate.setUTCDate(1);
  startDate.setUTCHours(0, 0, 0, 0);

  const presenter = new UsagePresenter();
  const { usage, tasks } = await presenter.call({
    organizationId: organization.id,
    startDate,
  });

  return typeddefer({
    usage,
    tasks,
    months,
    isCurrentMonth: startDate.toISOString() === months[0].toISOString(),
  });
}

const monthDateFormatter = new Intl.DateTimeFormat("en-US", {
  month: "long",
  year: "numeric",
  timeZone: "utc",
});

export default function Page() {
  const { usage, tasks, months, isCurrentMonth } = useTypedLoaderData<typeof loader>();
  const currentPlan = useCurrentPlan();
  const { value, replace } = useSearchParams();

  const month = value("month") ?? months[0].toISOString();

  return (
    <PageContainer>
      <NavBar>
        <PageTitle title="Usage" />
      </NavBar>
      <PageBody scrollable={true} className="p-0">
        <div className="flex flex-col gap-6">
          <div>
            <Select
              name="month"
              placeholder="Select a month"
              className="m-3"
              defaultValue={month}
              items={months.map((date) => ({
                label: monthDateFormatter.format(date),
                value: date.toISOString(),
              }))}
              text={(value) => monthDateFormatter.format(new Date(value))}
              setValue={(value) => {
                replace({ month: value });
              }}
              dropdownIcon
              variant="tertiary/small"
            >
              {(matches) =>
                matches.map((month) => (
                  <SelectItem key={month.value} value={month.value}>
                    {month.label}
                  </SelectItem>
                ))
              }
            </Select>
            <div className="flex w-full flex-col gap-2 border-t border-grid-dimmed p-3">
              <Suspense fallback={<Spinner />}>
                <Await
                  resolve={usage}
                  errorElement={
                    <div className="flex min-h-40 items-center justify-center">
                      <Paragraph variant="small">Failed to load graph.</Paragraph>
                    </div>
                  }
                >
                  {(usage) => (
                    <div className="flex items-end gap-8">
                      <div className="flex flex-col gap-1">
                        <Header2 className="whitespace-nowrap">
                          {isCurrentMonth ? "Month-to-date" : "Usage"}
                        </Header2>
                        <p className="whitespace-nowrap text-3xl font-medium text-text-bright">
                          {formatCurrency(usage.overall.current, false)}
                        </p>
                      </div>
                      <UsageBar
                        current={usage.overall.current}
                        isPaying={currentPlan?.v3Subscription?.isPaying ?? false}
                        tierLimit={
                          isCurrentMonth
                            ? (currentPlan?.v3Subscription?.plan?.limits.includedUsage ?? 0) / 100
                            : undefined
                        }
                      />
                    </div>
                  )}
                </Await>
              </Suspense>
            </div>
          </div>
          <div>
            <Header2 spacing className="pl-3">
              Usage by day
            </Header2>
            <div className="p-3">
              <Suspense
                fallback={
                  <div className="flex min-h-40 items-center justify-center">
                    <Spinner />
                  </div>
                }
              >
                <Await
                  resolve={usage}
                  errorElement={
                    <div className="flex min-h-40 items-center justify-center">
                      <Paragraph variant="small">Failed to load graph.</Paragraph>
                    </div>
                  }
                >
                  {(u) => <UsageChart data={u.timeSeries} />}
                </Await>
              </Suspense>
            </div>
          </div>
          <div>
            <Header2 spacing className="pl-3">
              Tasks
            </Header2>
            <Suspense fallback={<Spinner />}>
              <Await
                resolve={tasks}
                errorElement={
                  <div className="flex min-h-40 items-center justify-center">
                    <Paragraph variant="small">Failed to load.</Paragraph>
                  </div>
                }
              >
                {(tasks) => {
                  return (
                    <>
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHeaderCell>Task</TableHeaderCell>
                            <TableHeaderCell alignment="right">Runs</TableHeaderCell>
                            <TableHeaderCell alignment="right">Average duration</TableHeaderCell>
                            <TableHeaderCell alignment="right">Average cost</TableHeaderCell>
                            <TableHeaderCell alignment="right">Total duration</TableHeaderCell>
                            <TableHeaderCell alignment="right">Total cost</TableHeaderCell>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {tasks.length === 0 ? (
                            <TableRow>
                              <TableCell colSpan={6}>
                                <div className="flex items-center justify-center py-8">
                                  <Paragraph variant="base/bright">
                                    No runs for this period
                                  </Paragraph>
                                </div>
                              </TableCell>
                            </TableRow>
                          ) : (
                            tasks.map((task) => (
                              <TableRow key={task.taskIdentifier}>
                                <TableCell>{task.taskIdentifier}</TableCell>
                                <TableCell alignment="right" className="tabular-nums">
                                  {formatNumber(task.runCount)}
                                </TableCell>
                                <TableCell alignment="right">
                                  {formatDurationMilliseconds(task.averageDuration, {
                                    style: "short",
                                  })}
                                </TableCell>
                                <TableCell alignment="right" className="tabular-nums">
                                  {formatCurrencyAccurate(task.averageCost)}
                                </TableCell>
                                <TableCell alignment="right" className="tabular-nums">
                                  {formatDurationMilliseconds(task.totalDuration, {
                                    style: "short",
                                  })}
                                </TableCell>
                                <TableCell alignment="right" className="tabular-nums">
                                  {formatCurrencyAccurate(task.totalCost)}
                                </TableCell>
                              </TableRow>
                            ))
                          )}
                        </TableBody>
                      </Table>
                      <InfoPanel
                        icon={InformationCircleIcon}
                        variant="minimal"
                        panelClassName="max-w-full"
                      >
                        Dev environment runs are excluded from the usage data above, since they do
                        not have an associated compute cost.
                      </InfoPanel>
                    </>
                  );
                }}
              </Await>
            </Suspense>
          </div>
        </div>
      </PageBody>
    </PageContainer>
  );
}

const chartConfig = {
  dollars: {
    label: "Usage ($)",
    color: "#7655fd",
  },
} satisfies ChartConfig;

const tooltipDateFormatter = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
});

function UsageChart({ data }: { data: UsageSeriesData }) {
  const maxDollar = Math.max(...data.map((d) => d.dollars));
  const decimalPlaces = maxDollar < 1 ? 4 : 2;

  return (
    <ChartContainer config={chartConfig} className="max-h-96 min-h-40 w-full">
      <BarChart accessibilityLayer data={data}>
        <CartesianGrid vertical={false} />
        <XAxis
          fontSize={12}
          tickLine={false}
          tickMargin={10}
          axisLine={false}
          dataKey="date"
          tickFormatter={(value) => {
            if (!value) return "";
            const date = new Date(value);
            return `${date.getDate()}`;
          }}
          className="text-xs"
        />
        <YAxis
          fontSize={12}
          tickLine={false}
          tickMargin={10}
          axisLine={false}
          allowDecimals={true}
          tickFormatter={(value) => `$${value.toFixed(decimalPlaces)}`}
        />
        <ChartTooltip
          content={<ChartTooltipContent />}
          labelFormatter={(value, data) => {
            const dateString = data.at(0)?.payload.date;
            if (!dateString) {
              return "";
            }

            return tooltipDateFormatter.format(new Date(dateString));
          }}
        />
        <Bar dataKey="dollars" fill="var(--color-dollars)" radius={[4, 4, 0, 0]} />
      </BarChart>
    </ChartContainer>
  );
}
