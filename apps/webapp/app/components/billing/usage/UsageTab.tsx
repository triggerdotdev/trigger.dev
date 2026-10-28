import { MetricsLayout } from "~/components/layout/MetricsLayout";
import { LinkButton } from "~/components/primitives/Buttons";
import { Card } from "~/components/primitives/charts/Card";
import { Header2 } from "~/components/primitives/Headers";
import {
  buildUsageTree,
  monthlyUsageLeaves,
  sumUsage,
  USAGE_DIMENSIONS,
  usageDue,
  type MonthlyUsageView,
  type UsageDimension,
} from "~/utils/billingUsageBreakdown";
import {
  COST_SERIES_KEY,
  costDaySeries,
  fillMonthDays,
  includedUsageDollars,
} from "~/utils/billingUsageChart";
import { daysInUsageMonth } from "~/utils/billingUsagePeriod";
import {
  formatUnitPrice,
  formatUsageDollars,
  formatUsageQuantity,
  USD_CENTS_CREDIT_TYPE,
} from "~/utils/billingUsageFormat";
import { formatCurrency } from "~/utils/numberFormatter";
import { GroupingChips } from "./GroupingChips";
import { UsageBreakdownTable, UsageFooterRow } from "./UsageBreakdownTable";
import { UsageByDayChart } from "./UsageByDayChart";
import { UsageCreditsRows } from "./UsageCreditsRows";
import { UsagePlaceholder } from "./UsagePlaceholder";
import { UsageTotalBar } from "./UsageTotalBar";

export type UsagePlanLimits = {
  includedUsageDollars?: number;
  billingLimitDollars?: number;
  hasBillingLimit: boolean;
  billingLimitsPath: string;
};

export function UsageTab({
  usage,
  isFilling = false,
  limits,
  groupings,
  onGroupingsChange,
}: {
  usage: MonthlyUsageView;
  isFilling?: boolean;
  limits: UsagePlanLimits;
  groupings: UsageDimension[];
  onGroupingsChange: (groupings: UsageDimension[]) => void;
}) {
  const creditType = usage.creditType ?? USD_CENTS_CREDIT_TYPE;
  const minorUnits = creditType.currency?.minorUnitsPerUnit ?? 1;
  const toDollars = (amount: number) => amount / minorUnits;
  const money = (amount: number) => formatUsageDollars(toDollars(amount));

  const leaves = monthlyUsageLeaves(usage.lines);
  const totals = sumUsage(leaves);
  const tree = buildUsageTree(leaves, groupings, "cost");
  const due = usageDue(usage);
  const total = (value: string) => (isFilling ? <UsagePlaceholder /> : value);

  return (
    <>
      <MetricsLayout.Grid columns={{ base: 1 }}>
        <Card className="pb-4">
          <Card.Content className="pl-4 pr-4">
            <div className="flex flex-col gap-2">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-baseline gap-2">
                  <p className="whitespace-nowrap text-3xl font-medium text-text-bright">
                    {isFilling ? <UsagePlaceholder className="w-28" /> : money(usage.total)}
                  </p>
                  <Header2 className="whitespace-nowrap">
                    {usage.isCurrentMonth ? "month-to-date" : "usage"}
                  </Header2>
                </div>
                <LinkButton variant="secondary/small" to={limits.billingLimitsPath}>
                  {limits.hasBillingLimit ? "Update billing limit" : "Set billing limit"}
                </LinkButton>
              </div>
              {isFilling ? (
                <UsagePlaceholder className="h-3 w-full" />
              ) : (
                <UsageTotalBar
                  used={toDollars(usage.total)}
                  included={includedUsageDollars(usage, minorUnits, limits.includedUsageDollars)}
                  limit={usage.isCurrentMonth ? limits.billingLimitDollars : undefined}
                  format={(amount) => formatCurrency(amount, false)}
                />
              )}
            </div>
          </Card.Content>
        </Card>
      </MetricsLayout.Grid>
      <MetricsLayout.Grid>
        <Card>
          <Card.Header>Usage by day</Card.Header>
          <Card.Content>
            <UsageByDayChart
              data={costDaySeries(
                fillMonthDays(usage.days, daysInUsageMonth(usage.month), (date) => ({
                  date,
                  total: 0,
                })),
                minorUnits
              )}
              series={[{ key: COST_SERIES_KEY, label: "Usage $", color: "#7655fd" }]}
              yTickFormatter={formatUsageDollars}
              valueFormatter={formatUsageDollars}
              isLoading={isFilling}
            />
          </Card.Content>
        </Card>
      </MetricsLayout.Grid>
      <MetricsLayout.Content
        toolbar={
          <>
            <Header2 className="pl-1.5">Usage breakdown</Header2>
            <GroupingChips
              groupings={groupings}
              available={USAGE_DIMENSIONS}
              onChange={onGroupingsChange}
            />
          </>
        }
      >
        <UsageBreakdownTable
          key={`${usage.month}:${groupings.join(",")}`}
          nodes={tree}
          groupings={groupings}
          emptyMessage={
            isFilling
              ? "Loading earlier days…"
              : usage.total > 0
                ? "No breakdown available for this month"
                : "No usage for this month"
          }
          columns={[
            {
              header: "Quantity",
              text: (node) =>
                node.usageType
                  ? formatUsageQuantity(
                      node.usageType,
                      node.usageType === "compute" ? node.computeMs : node.runs
                    )
                  : "–",
            },
            {
              header: "Rate",
              dimmed: true,
              text: (node) =>
                node.usageType && node.unitPrice !== null
                  ? formatUnitPrice(node.usageType, node.unitPrice, creditType)
                  : null,
            },
            { header: "Cost", text: (node) => money(node.cost) },
            { header: "Share", share: (node) => node.cost, whole: totals.cost },
          ]}
          footer={
            <>
              <UsageFooterRow label="Usage" cells={[null, null, total(money(usage.total)), null]} />
              <UsageCreditsRows
                available={usage.creditsForUsage ?? usage.creditsApplied}
                applied={usage.creditsApplied}
                credits={usage.credits ?? []}
                money={money}
                isLoading={isFilling}
                columns={4}
              />
              <UsageFooterRow
                label={usage.isCurrentMonth ? "Usage due so far" : "Usage due"}
                cells={[null, null, total(money(due)), null]}
                emphasis
              />
            </>
          }
        />
      </MetricsLayout.Content>
    </>
  );
}
