import { ArrowRightIcon } from "@heroicons/react/24/solid";
import { Await } from "@remix-run/react";
import { LoaderFunctionArgs } from "@remix-run/server-runtime";
import { formatDurationMilliseconds } from "@trigger.dev/core/v3";
import { Suspense } from "react";
import { Bar, BarChart, Rectangle, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { redirect, typeddefer, useTypedLoaderData } from "remix-typedjson";
import { UsageBar } from "~/components/billing/v3/UsageBar";
import { PageBody, PageContainer } from "~/components/layout/AppLayout";
import { Header2, Header3 } from "~/components/primitives/Headers";
import { NavBar, PageTitle } from "~/components/primitives/PageHeader";
import { Paragraph } from "~/components/primitives/Paragraph";
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
import { UsagePresenter } from "~/presenters/v3/UsagePresenter.server";
import { requireUserId } from "~/services/session.server";
import { formatCurrency, formatCurrencyAccurate, formatNumber } from "~/utils/numberFormatter";
import { OrganizationParamsSchema, organizationPath } from "~/utils/pathBuilder";
import { useCurrentPlan } from "../_app.orgs.$organizationSlug/route";

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

  const presenter = new UsagePresenter();
  const { past30Days, usage, tasks } = await presenter.call({ organizationId: organization.id });

  return typeddefer({
    past30Days,
    usage,
    tasks,
  });
}

const dateFormatter = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
});

const tooltipStyle = {
  display: "flex",
  alignItems: "center",
  gap: "0rem",
  borderRadius: "0.25rem",
  border: "1px solid #272A2E",
  backgroundColor: "#1A1B1F",
  padding: "0.3rem 0.5rem",
  fontSize: "0.75rem",
  color: "#E2E8F0",
};

export default function ChoosePlanPage() {
  const { usage, past30Days, tasks } = useTypedLoaderData<typeof loader>();
  const currentPlan = useCurrentPlan();

  return (
    <PageContainer>
      <NavBar>
        <PageTitle title="Usage" />
      </NavBar>
      <PageBody scrollable={true}>
        <div className="flex flex-col gap-6">
          <div>
            <Header2 spacing>This month</Header2>
            <div className="flex w-full flex-col gap-2 rounded-sm border border-grid-dimmed p-4">
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
                    <>
                      <div className="flex w-full items-center gap-6">
                        <div className="flex flex-col gap-2">
                          <Header3 className="">Month-to-date</Header3>
                          <p className="text-3xl font-medium text-text-bright">
                            {formatCurrency(usage.current, false)}
                          </p>
                        </div>
                        <ArrowRightIcon className="h-6 w-6 text-text-dimmed/50" />
                        <div className="flex flex-col gap-2 text-text-dimmed">
                          <Header3 className="text-text-dimmed">Projected</Header3>
                          <p className="text-3xl font-medium">
                            {formatCurrency(usage.projected, false)}
                          </p>
                        </div>
                      </div>
                      <UsageBar
                        current={usage.current}
                        projectedUsage={usage.projected}
                        tierLimit={
                          (currentPlan?.v3Subscription?.plan?.limits.includedUsage ?? 0) / 100
                        }
                      />
                    </>
                  )}
                </Await>
              </Suspense>
            </div>
          </div>
          <div>
            <Header2 spacing>Past 30 days</Header2>
            <div className="rounded-sm border border-grid-dimmed p-4">
              <Header3 spacing>Usage</Header3>
              <Suspense
                fallback={
                  <div className="flex min-h-40 items-center justify-center">
                    <Spinner />
                  </div>
                }
              >
                <Await
                  resolve={past30Days}
                  errorElement={
                    <div className="flex min-h-40 items-center justify-center">
                      <Paragraph variant="small">Failed to load graph.</Paragraph>
                    </div>
                  }
                >
                  {(past30Days) => (
                    <ResponsiveContainer width="100%" height="100%" className="min-h-96">
                      <BarChart
                        data={past30Days}
                        margin={{
                          top: 20,
                          right: 0,
                          left: -10,
                          bottom: 10,
                        }}
                      >
                        <XAxis
                          stroke="#5F6570"
                          fontSize={12}
                          tickLine={false}
                          axisLine={true}
                          dataKey={(item: { date: string }) => {
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
                          formatter={(value, data) => [
                            `$${
                              typeof value === "number" ? value.toFixed(8) : value.toLocaleString()
                            }`,
                            "",
                          ]}
                        />
                        <Bar
                          dataKey="dollars"
                          fill="#28BF5C"
                          activeBar={<Rectangle fill="#5ADE87" />}
                        />
                      </BarChart>
                    </ResponsiveContainer>
                  )}
                </Await>
              </Suspense>
            </div>
          </div>
          <div>
            <Header2 spacing>Tasks</Header2>
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
                              <Paragraph variant="small">No runs to display yet.</Paragraph>
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
