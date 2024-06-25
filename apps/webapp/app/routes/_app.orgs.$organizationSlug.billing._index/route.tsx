import { ArrowRightIcon } from "@heroicons/react/20/solid";
import { ArrowUpCircleIcon } from "@heroicons/react/24/outline";
import { Await, useLoaderData } from "@remix-run/react";
import { DataFunctionArgs, defer } from "@remix-run/server-runtime";
import { Suspense } from "react";
import { Bar, BarChart, ResponsiveContainer, Tooltip, TooltipProps, XAxis, YAxis } from "recharts";
import { ConcurrentRunsChart } from "~/components/billing/v2/ConcurrentRunsChart";
import { UsageBar } from "~/components/billing/v2/UsageBar";
import { LinkButton } from "~/components/primitives/Buttons";
import { Callout } from "~/components/primitives/Callout";
import { DailyRunsChart } from "~/components/billing/v2/DailyRunsChat";
import { DateTime } from "~/components/primitives/DateTime";
import { Header2, Header3 } from "~/components/primitives/Headers";
import { Paragraph } from "~/components/primitives/Paragraph";
import { Spinner } from "~/components/primitives/Spinner";
import { useOrganization } from "~/hooks/useOrganizations";
import { OrgUsagePresenter } from "~/presenters/OrgUsagePresenter.server";
import { requireUserId } from "~/services/session.server";
import { formatCurrency, formatNumberCompact } from "~/utils/numberFormatter";
import { OrganizationParamsSchema, plansPath } from "~/utils/pathBuilder";
import { useCurrentPlan } from "../_app.orgs.$organizationSlug/route";

export async function loader({ request, params }: DataFunctionArgs) {
  const userId = await requireUserId(request);
  const { organizationSlug } = OrganizationParamsSchema.parse(params);

  const presenter = new OrgUsagePresenter();
  const usageData = presenter.call({ userId, slug: organizationSlug, request });
  return defer({ usageData });
}

const CustomTooltip = ({ active, payload, label }: TooltipProps<number, string>) => {
  if (active && payload) {
    return (
      <div className="flex gap-1 rounded border border-grid-bright bg-background-dimmed px-3 py-2 text-xs text-text-bright">
        <p>{label}:</p>
        <p>{payload[0].value}</p>
      </div>
    );
  }

  return null;
};

export default function Page() {
  const organization = useOrganization();
  const { usageData } = useLoaderData<typeof loader>();
  const currentPlan = useCurrentPlan();

  const hitsRunLimit = currentPlan?.usage?.runCountCap
    ? currentPlan.usage.currentRunCount > currentPlan.usage.runCountCap
    : false;

  return (
    <div className="flex flex-col gap-4 px-4">
      <Suspense
        fallback={
          <>
            <LoadingElement title="Concurrent runs" />
            <LoadingElement title="Runs" />
          </>
        }
      >
        <Await
          resolve={usageData}
          errorElement={<Paragraph>There was a problem loading your usage data.</Paragraph>}
        >
          {(data) => {
            const hitConcurrencyLimit = currentPlan?.subscription?.limits.concurrentRuns
              ? data.concurrencyData.some(
                  (c) =>
                    c.maxConcurrentRuns >=
                    (currentPlan.subscription?.limits.concurrentRuns ?? Infinity)
                )
              : false;

            return (
              <>
                <div>
                  <Header2 spacing>Concurrent runs</Header2>
                  <div className="flex w-full flex-col gap-5 rounded border border-grid-bright p-6">
                    {hitConcurrencyLimit && (
                      <Callout
                        variant={"pricing"}
                        cta={
                          <LinkButton
                            variant="primary/small"
                            LeadingIcon={ArrowUpCircleIcon}
                            leadingIconClassName="px-0"
                            to={plansPath(organization)}
                          >
                            Increase concurrent runs
                          </LinkButton>
                        }
                      >
                        {`Some of your runs are being queued because the number of concurrent runs is limited to
            ${currentPlan?.subscription?.limits.concurrentRuns}.`}
                      </Callout>
                    )}
                    <ConcurrentRunsChart
                      data={data.concurrencyData}
                      concurrentRunsLimit={currentPlan?.subscription?.limits.concurrentRuns}
                      hasConcurrencyData={data.hasConcurrencyData}
                    />
                  </div>
                </div>

                <div className="@container">
                  <Header2 spacing>Runs</Header2>
                  <div className="flex flex-col gap-5 rounded border border-grid-bright p-6">
                    {hitsRunLimit && (
                      <Callout
                        variant={"error"}
                        cta={
                          <LinkButton
                            variant="primary/small"
                            LeadingIcon={ArrowUpCircleIcon}
                            leadingIconClassName="px-0"
                            to={plansPath(organization)}
                          >
                            Upgrade
                          </LinkButton>
                        }
                      >
                        <Paragraph variant="small" className="text-white">
                          You have exceeded the monthly{" "}
                          {formatNumberCompact(currentPlan?.subscription?.limits.runs ?? 0)} runs
                          limit. Upgrade to a paid plan before{" "}
                          <DateTime
                            date={data.periodEnd}
                            includeSeconds={false}
                            includeTime={false}
                          />
                          .
                        </Paragraph>
                      </Callout>
                    )}
                    <div className="flex flex-col gap-x-8 @4xl:flex-row">
                      <div className="flex w-full flex-col gap-4">
                        {data.runCostEstimation !== undefined &&
                          data.projectedRunCostEstimation !== undefined && (
                            <div className="flex w-full items-center gap-6">
                              <div className="flex flex-col gap-2">
                                <Header3 className="">Month-to-date</Header3>
                                <p className="text-3xl font-medium text-text-bright">
                                  {formatCurrency(data.runCostEstimation, false)}
                                </p>
                              </div>
                              <ArrowRightIcon className="h-6 w-6 text-text-dimmed/50" />
                              <div className="flex flex-col gap-2 text-text-dimmed">
                                <Header3 className="text-text-dimmed">Projected</Header3>
                                <p className="text-3xl font-medium">
                                  {formatCurrency(data.projectedRunCostEstimation, false)}
                                </p>
                              </div>
                            </div>
                          )}
                        <UsageBar
                          numberOfCurrentRuns={data.runsCount}
                          tierRunLimit={currentPlan?.usage.runCountCap}
                          projectedRuns={data.projectedRunsCount}
                          subscribedToPaidTier={
                            (currentPlan && currentPlan.subscription?.isPaying) ?? false
                          }
                        />
                      </div>
                      <div className="relative w-full">
                        <Header3 className="mb-4">Monthly runs</Header3>
                        {!data.hasMonthlyRunData && (
                          <Paragraph className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2">
                            No runs to show
                          </Paragraph>
                        )}
                        <ResponsiveContainer width="100%" height={200}>
                          <BarChart
                            data={data.monthlyRunsData}
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
                            <Tooltip
                              cursor={{ fill: "rgba(255,255,255,0.05)" }}
                              content={<CustomTooltip />}
                            />
                            <Bar dataKey="total" fill="#16A34A" radius={[3, 3, 0, 0]} />
                          </BarChart>
                        </ResponsiveContainer>
                      </div>
                    </div>
                    <div>
                      <Header3 className="mb-4">Daily runs</Header3>
                      <DailyRunsChart
                        data={data.dailyRunsData}
                        hasDailyRunsData={data.hasDailyRunsData}
                      />
                    </div>
                  </div>
                </div>
              </>
            );
          }}
        </Await>
      </Suspense>
    </div>
  );
}

function LoadingElement({ title }: { title: string }) {
  return (
    <div>
      <Header2 spacing>{title}</Header2>
      <div className="flex h-96 w-full items-center justify-center gap-5 rounded border border-grid-bright p-6">
        <Spinner />
      </div>
    </div>
  );
}
