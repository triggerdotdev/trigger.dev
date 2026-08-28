import { Await } from "@remix-run/react";
import { type LoaderFunctionArgs } from "@remix-run/server-runtime";
import { formatDurationMilliseconds } from "@trigger.dev/core/v3";
import { Suspense, useMemo } from "react";
import { redirect, typeddefer, useTypedLoaderData } from "remix-typedjson";
import { URL } from "url";
import { UsageBar } from "~/components/billing/UsageBar";
import { getUsageBarBillingLimitDollars } from "~/components/billing/billingAlertsFormat";
import { PageContainer } from "~/components/layout/AppLayout";
import { MetricsLayout } from "~/components/layout/MetricsLayout";
import { LinkButton } from "~/components/primitives/Buttons";
import { Card } from "~/components/primitives/charts/Card";
import type { ChartConfig } from "~/components/primitives/charts/Chart";
import { Chart } from "~/components/primitives/charts/ChartCompound";
import { Header2 } from "~/components/primitives/Headers";
import { NavBar, PageTitle } from "~/components/primitives/PageHeader";
import { Paragraph } from "~/components/primitives/Paragraph";
import { Select, SelectItem } from "~/components/primitives/Select";
import { Spinner } from "~/components/primitives/Spinner";
import {
  Table,
  TableBlankRow,
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
import { getPromoCredits } from "~/services/platform.v3.server";
import { requireUserId } from "~/services/session.server";
import { formatCurrency, formatCurrencyAccurate, formatNumber } from "~/utils/numberFormatter";
import { useBillingLimit, useOrganization } from "~/hooks/useOrganizations";
import {
  OrganizationParamsSchema,
  organizationPath,
  v3BillingLimitsPath,
} from "~/utils/pathBuilder";
import { useCurrentPlan } from "../_app.orgs.$organizationSlug/route";
import { pageMeta } from "~/utils/pageTitle";

export const meta = pageMeta("Usage");

export async function loader({ params, request }: LoaderFunctionArgs) {
  const userId = await requireUserId(request);
  const { organizationSlug } = OrganizationParamsSchema.parse(params);

  const { isManagedCloud } = featuresForRequest(request);
  if (!isManagedCloud) {
    return redirect(organizationPath({ slug: organizationSlug }));
  }

  const organization = await prisma.organization.findFirst({
    where: { slug: organizationSlug, members: { some: { userId } } },
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

  // Credit-grant balance (promo now, other grant types later). Cheap + cached +
  // fails to null, and applies to any org with grants — not gated on plan tier.
  const promoCredits = await getPromoCredits(organization.id);

  return typeddefer({
    usage,
    tasks,
    months,
    isCurrentMonth: startDate.toISOString() === months[0].toISOString(),
    promoCredits,
  });
}

const creditExpiryFormatter = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
  timeZone: "utc",
});

const monthDateFormatter = new Intl.DateTimeFormat("en-US", {
  month: "long",
  year: "numeric",
  timeZone: "utc",
});

export default function Page() {
  const { usage, tasks, months, isCurrentMonth, promoCredits } =
    useTypedLoaderData<typeof loader>();
  const currentPlan = useCurrentPlan();
  const organization = useOrganization();
  const billingLimit = useBillingLimit();
  const hasBillingLimit =
    billingLimit !== undefined && billingLimit.isConfigured && billingLimit.mode === "custom";
  const planLimitCents = currentPlan?.v3Subscription?.plan?.limits.includedUsage ?? 0;
  // Enterprise bills against prepaid credits, not a per-month included-usage tier,
  // so the "Included usage" marker doesn't apply.
  const isEnterprise = currentPlan?.v3Subscription?.plan?.type === "enterprise";
  const billingLimitDollars = isCurrentMonth
    ? getUsageBarBillingLimitDollars(billingLimit, planLimitCents)
    : undefined;
  const { value, replace } = useSearchParams();

  const month = value("month") ?? months[0].toISOString();

  return (
    <PageContainer>
      <NavBar>
        <PageTitle title="Usage" />
      </NavBar>
      <MetricsLayout.Root>
        <MetricsLayout.Filters>
          <div className="flex items-center gap-2">
            <Select
              name="month"
              placeholder="Select a month"
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
          </div>
        </MetricsLayout.Filters>

        <MetricsLayout.Grid columns={{ base: 1 }}>
          {promoCredits && (
            <Card className="pb-4">
              <Card.Content className="pl-4 pr-4">
                <div className="flex flex-col gap-2">
                  <div className="flex items-baseline gap-2">
                    <p className="whitespace-nowrap text-3xl font-medium text-text-bright">
                      {formatCurrency(promoCredits.remainingCents / 100, false)}
                    </p>
                    <Header2 className="whitespace-nowrap">credits</Header2>
                  </div>
                  <div className="flex w-full flex-col gap-4">
                    <div className="h-3 w-full overflow-hidden rounded-sm bg-background-raised">
                      <div
                        className="h-full rounded-sm bg-blue-500"
                        style={{
                          width: `${
                            promoCredits.grantedCents > 0
                              ? Math.min(
                                  100,
                                  Math.max(
                                    0,
                                    (promoCredits.remainingCents / promoCredits.grantedCents) * 100
                                  )
                                )
                              : 0
                          }%`,
                        }}
                      />
                    </div>
                    <Paragraph variant="extra-small" className="text-text-bright">
                      {formatCurrency(promoCredits.remainingCents / 100, false)} of{" "}
                      {formatCurrency(promoCredits.grantedCents / 100, false)} remaining
                      {promoCredits.expiresAt
                        ? `. Expires ${creditExpiryFormatter.format(new Date(promoCredits.expiresAt))}`
                        : ""}
                    </Paragraph>
                  </div>
                </div>
              </Card.Content>
            </Card>
          )}
          <Card className="pb-4">
            <Card.Content className="pl-4 pr-4">
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
                    <div className="flex flex-col gap-2">
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex items-baseline gap-2">
                          <p className="whitespace-nowrap text-3xl font-medium text-text-bright">
                            {formatCurrency(usage.overall.current, false)}
                          </p>
                          <Header2 className="whitespace-nowrap">
                            {isCurrentMonth ? "month-to-date" : "usage"}
                          </Header2>
                        </div>
                        <LinkButton
                          variant="secondary/small"
                          to={v3BillingLimitsPath(organization)}
                        >
                          {hasBillingLimit ? "Update billing limit" : "Set billing limit"}
                        </LinkButton>
                      </div>
                      <UsageBar
                        current={usage.overall.current}
                        isPaying={currentPlan?.v3Subscription?.isPaying ?? false}
                        tierLimit={
                          isCurrentMonth && !isEnterprise ? planLimitCents / 100 : undefined
                        }
                        billingLimit={billingLimitDollars}
                      />
                    </div>
                  )}
                </Await>
              </Suspense>
            </Card.Content>
          </Card>
        </MetricsLayout.Grid>

        <MetricsLayout.Grid>
          <Card>
            <Card.Header>Usage by day</Card.Header>
            <Card.Content>
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
            </Card.Content>
          </Card>
        </MetricsLayout.Grid>
        <MetricsLayout.Content>
          <div className="mt-2.5 flex items-baseline justify-between gap-2 pl-3 pr-3">
            <Header2>Tasks</Header2>
            <Paragraph variant="extra-small" className="text-right text-text-dimmed">
              Dev environment runs are excluded from the usage data above, since they do not have an
              associated compute cost.
            </Paragraph>
          </div>
          <Suspense fallback={<Spinner />}>
            <Await
              resolve={tasks}
              errorElement={
                <div className="flex min-h-40 items-center justify-center">
                  <Paragraph variant="small">Failed to load.</Paragraph>
                </div>
              }
            >
              {(tasks) => (
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
                      <TableBlankRow colSpan={6}>
                        <Paragraph className="w-auto" variant="base/bright">
                          No runs for this period
                        </Paragraph>
                      </TableBlankRow>
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
              )}
            </Await>
          </Suspense>
        </MetricsLayout.Content>
      </MetricsLayout.Root>
    </PageContainer>
  );
}

const chartConfig = {
  dollars: {
    label: "Usage $",
    color: "#7655fd",
  },
} satisfies ChartConfig;

const tooltipDateFormatter = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
});

const xAxisTickFormatter = (value: string) => {
  if (!value) return "";
  const date = new Date(value);
  return `${date.getDate()}`;
};

const tooltipLabelFormatter = (label: string) => {
  if (!label) return "";
  return tooltipDateFormatter.format(new Date(label));
};

function UsageChart({ data }: { data: UsageSeriesData }) {
  const maxDollar = Math.max(...data.map((d) => d.dollars));
  const decimalPlaces = maxDollar < 1 ? 4 : 2;

  const yAxisTickFormatter = useMemo(
    () => (value: number) => `$${value.toFixed(decimalPlaces)}`,
    [decimalPlaces]
  );

  return (
    <div className="h-80">
      <Chart.Root
        config={chartConfig}
        data={data}
        dataKey="date"
        showLegend={false}
        enableZoom={false}
        fillContainer
      >
        <Chart.Bar
          xAxisProps={{ tickFormatter: xAxisTickFormatter }}
          yAxisProps={{ tickFormatter: yAxisTickFormatter, allowDecimals: true }}
          tooltipLabelFormatter={tooltipLabelFormatter}
        />
      </Chart.Root>
    </div>
  );
}
