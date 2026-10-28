import type { ReactNode } from "react";
import { getSeriesColor } from "~/components/code/chartColors";
import { MetricsLayout } from "~/components/layout/MetricsLayout";
import { Callout } from "~/components/primitives/Callout";
import { Card } from "~/components/primitives/charts/Card";
import { Header2 } from "~/components/primitives/Headers";
import { Paragraph } from "~/components/primitives/Paragraph";
import SegmentedControl from "~/components/primitives/SegmentedControl";
import { SimpleTooltip } from "~/components/primitives/Tooltip";
import {
  buildUsageTree,
  PROJECT_DIMENSIONS,
  projectUsageLeaves,
  restoreGrouping,
  usageProjects,
  sumUsage,
  type ProjectUsageView,
  type UsageDimension,
} from "~/utils/billingUsageBreakdown";
import {
  fillMonthDays,
  projectDaySeries,
  projectTotals,
  type ProjectMetric,
} from "~/utils/billingUsageChart";
import { daysInUsageMonth } from "~/utils/billingUsagePeriod";
import {
  formatComputeTime,
  formatDurationTick,
  sharePercent,
  type ComputeTimeFormat,
} from "~/utils/billingUsageFormat";
import { formatNumber, formatNumberCompact } from "~/utils/numberFormatter";
import { ALL_PROJECTS } from "~/utils/billingUsagePageState";
import { GroupingChips } from "./GroupingChips";
import { UsageBreakdownTable, UsageFooterRow } from "./UsageBreakdownTable";
import { UsageByDayChart } from "./UsageByDayChart";
import { UsagePlaceholder } from "./UsagePlaceholder";

export function ProjectUsageTab({
  usage,
  isFilling = false,
  selectedProject,
  groupings,
  metric,
  timeFormat,
  onGroupingsChange,
  onMetricChange,
  onTimeFormatChange,
}: {
  usage: ProjectUsageView;
  isFilling?: boolean;
  selectedProject: string;
  groupings: UsageDimension[];
  metric: ProjectMetric;
  timeFormat: ComputeTimeFormat;
  onGroupingsChange: (groupings: UsageDimension[]) => void;
  onMetricChange: (metric: ProjectMetric) => void;
  onTimeFormatChange: (format: ComputeTimeFormat) => void;
}) {
  const isAllProjects = selectedProject === ALL_PROJECTS;
  const perProject = projectTotals(usage.days);
  const projects = usageProjects(usage);
  const ranked = [...projects].sort(
    (a, b) => (perProject.get(b.id)?.computeMs ?? 0) - (perProject.get(a.id)?.computeMs ?? 0)
  );
  const colorOf = (projectId: string) =>
    getSeriesColor(
      Math.max(
        0,
        ranked.findIndex((project) => project.id === projectId)
      )
    );
  const charted = isAllProjects
    ? ranked.filter((project) => (perProject.get(project.id)?.[metric] ?? 0) > 0)
    : ranked.filter((project) => project.id === selectedProject);

  const lines = isAllProjects
    ? usage.lines
    : usage.lines.filter((line) => line.projectId === selectedProject);
  const leaves = projectUsageLeaves(lines);
  const totals = sumUsage(leaves);
  const available = isAllProjects
    ? PROJECT_DIMENSIONS
    : PROJECT_DIMENSIONS.filter((dimension) => dimension !== "project");
  const visibleGroupings = groupings.filter((dimension) => available.includes(dimension));
  const activeGroupings = visibleGroupings.length > 0 ? visibleGroupings : available.slice(0, 1);
  const tree = buildUsageTree(leaves, activeGroupings, "computeMs");
  const period = usage.isCurrentMonth ? "month-to-date" : "this month";
  const duration = (milliseconds: number) => formatComputeTime(milliseconds, timeFormat);
  const allComputeMs = ranked.reduce(
    (sum, project) => sum + (perProject.get(project.id)?.computeMs ?? 0),
    0
  );

  return (
    <>
      <MetricsLayout.Grid columns={{ base: 1 }}>
        {usage.truncated && (
          <Callout variant="warning">
            This month has more usage than we could load, so these figures are incomplete.
          </Callout>
        )}
        <Card className="pb-4">
          <Card.Content className="flex flex-col gap-4 pl-4 pr-4">
            <div className="flex flex-wrap gap-8">
              <Figure
                label={`Compute time, ${period}`}
                value={
                  isFilling ? <UsagePlaceholder className="w-28" /> : duration(totals.computeMs)
                }
              />
              <Figure
                label={`Runs, ${period}`}
                value={
                  isFilling ? <UsagePlaceholder className="w-20" /> : formatNumber(totals.runs)
                }
              />
            </div>
            {allComputeMs > 0 && !isFilling && (
              <div className="flex flex-col gap-2">
                <Paragraph variant="extra-small">Compute time by project</Paragraph>
                <div className="flex h-3 w-full overflow-hidden rounded-sm bg-background-raised">
                  {ranked.map((project) => {
                    const computeMs = perProject.get(project.id)?.computeMs ?? 0;
                    if (computeMs === 0) return null;
                    return (
                      <SimpleTooltip
                        key={project.id}
                        button={
                          <div
                            className="h-3"
                            style={{
                              width: `${sharePercent(computeMs, allComputeMs)}%`,
                              backgroundColor: colorOf(project.id),
                              opacity: isAllProjects || project.id === selectedProject ? 1 : 0.25,
                            }}
                          />
                        }
                        content={`${project.name}: ${duration(computeMs)}`}
                        asChild
                      />
                    );
                  })}
                </div>
                <div className="flex flex-wrap gap-x-4 gap-y-1">
                  {ranked.map((project) => {
                    const projectTotal = perProject.get(project.id) ?? { computeMs: 0, runs: 0 };
                    return (
                      <span
                        key={project.id}
                        className="flex items-center gap-1.5 text-xs text-text-dimmed"
                        style={{
                          opacity: isAllProjects || project.id === selectedProject ? 1 : 0.4,
                        }}
                      >
                        <span
                          className="size-2 rounded-sm"
                          style={{ backgroundColor: colorOf(project.id) }}
                        />
                        <span className="text-text-bright">{project.name}</span>
                        <span className="tabular-nums">{duration(projectTotal.computeMs)}</span>
                        <span className="tabular-nums">
                          · {formatNumber(projectTotal.runs)} runs
                        </span>
                      </span>
                    );
                  })}
                </div>
              </div>
            )}
          </Card.Content>
        </Card>
      </MetricsLayout.Grid>
      <MetricsLayout.Grid>
        <Card>
          <Card.Header>
            {metric === "computeMs" ? "Compute time by day" : "Runs by day"}
            <Card.Accessory>
              <SegmentedControl
                name="metric"
                value={metric}
                variant="secondary/small"
                options={[
                  { label: "Compute time", value: "computeMs" },
                  { label: "Runs", value: "runs" },
                ]}
                onChange={(value) => onMetricChange(value as ProjectMetric)}
              />
            </Card.Accessory>
          </Card.Header>
          <Card.Content>
            <UsageByDayChart
              data={projectDaySeries(
                fillMonthDays(usage.days, daysInUsageMonth(usage.month), (date) => ({
                  date,
                  projects: [],
                })),
                charted.map((project) => project.id),
                metric
              )}
              series={charted.map((project) => ({
                key: project.id,
                label: project.name,
                color: colorOf(project.id),
              }))}
              yTickFormatter={(value) =>
                metric === "computeMs" && timeFormat === "readable"
                  ? formatDurationTick(value)
                  : formatNumberCompact(value)
              }
              valueFormatter={(value) =>
                metric === "computeMs" ? duration(value) : `${formatNumber(value)} runs`
              }
              isLoading={isFilling}
            />
          </Card.Content>
        </Card>
      </MetricsLayout.Grid>
      <MetricsLayout.Content
        toolbar={
          <>
            <Header2 className="pl-1.5">Usage breakdown</Header2>
            <div className="flex flex-wrap items-center justify-end gap-2">
              <GroupingChips
                groupings={activeGroupings}
                available={available}
                onChange={(edited) =>
                  onGroupingsChange(
                    isAllProjects ? edited : restoreGrouping(groupings, edited, "project")
                  )
                }
              />
              <SegmentedControl
                name="timeFormat"
                value={timeFormat}
                variant="secondary/small"
                options={[
                  { label: "ms", value: "ms" },
                  { label: "1d 2h 3m", value: "readable" },
                ]}
                onChange={(value) => onTimeFormatChange(value as ComputeTimeFormat)}
              />
            </div>
          </>
        }
      >
        <UsageBreakdownTable
          key={`${usage.month}:${selectedProject}:${activeGroupings.join(",")}`}
          nodes={tree}
          groupings={activeGroupings}
          projects={projects}
          emptyMessage={
            isFilling ? "Loading earlier days…" : "No compute time or runs for this month"
          }
          columns={[
            {
              header: "Compute time",
              text: (node) => (node.computeMs > 0 ? duration(node.computeMs) : "–"),
            },
            { header: "Share", share: (node) => node.computeMs, whole: totals.computeMs },
            { header: "Runs", text: (node) => formatNumber(node.runs) },
            { header: "Share", share: (node) => node.runs, whole: totals.runs },
          ]}
          footer={
            <UsageFooterRow
              label={isAllProjects ? "All projects" : "Total"}
              cells={
                isFilling
                  ? [
                      <UsagePlaceholder key="compute" />,
                      null,
                      <UsagePlaceholder key="runs" />,
                      null,
                    ]
                  : [duration(totals.computeMs), null, formatNumber(totals.runs), null]
              }
              emphasis
            />
          }
        />
      </MetricsLayout.Content>
    </>
  );
}

function Figure({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <Paragraph variant="extra-small">{label}</Paragraph>
      <p className="whitespace-nowrap text-2xl font-medium tabular-nums text-text-bright">
        {value}
      </p>
    </div>
  );
}
