import type { BillingAddOns } from "@trigger.dev/billing";
import { useEffect, useRef } from "react";
import { MetricsLayout } from "~/components/layout/MetricsLayout";
import { DateTime } from "~/components/primitives/DateTime";
import { Paragraph } from "~/components/primitives/Paragraph";
import { Select, SelectItem } from "~/components/primitives/Select";
import { Spinner } from "~/components/primitives/Spinner";
import { TabButton, TabContainer } from "~/components/primitives/Tabs";
import { useOptimisticLocation } from "~/hooks/useOptimisticLocation";
import { useSearchParams } from "~/hooks/useSearchParam";
import type { BillingUsageResult } from "~/services/billingUsage.server";
import {
  usageProjects,
  type MonthlyUsageView,
  type ProjectUsageView,
  type UsageDimension,
} from "~/utils/billingUsageBreakdown";
import {
  ALL_PROJECTS,
  browserGroupingsStore,
  parseUsagePageState,
  storedGroupingsToRestore,
  USAGE_PAGE_PARAMS,
  writeStoredGroupings,
  type GroupingsParam,
  type UsagePageTab,
} from "~/utils/billingUsagePageState";
import { AddOnsTab } from "./AddOnsTab";
import { BillingUsageErrorPanel } from "./BillingUsageErrorPanel";
import { MonthStepper } from "./MonthStepper";
import { ProjectUsageTab } from "./ProjectUsageTab";
import { UsageTab, type UsagePlanLimits } from "./UsageTab";
import { useUsageFill } from "./useUsageFill";

const TABS: { value: UsagePageTab; label: string }[] = [
  { value: "usage", label: "Usage" },
  { value: "projects", label: "By project" },
  { value: "addons", label: "Add-ons" },
];

export function BillingUsageView({
  organizationSlug,
  months,
  month,
  addOns,
  limits,
  ...initial
}: {
  organizationSlug: string;
  months: string[];
  month: string;
  usage: BillingUsageResult<MonthlyUsageView>;
  projectUsage: BillingUsageResult<ProjectUsageView>;
  addOns: BillingUsageResult<BillingAddOns>;
  limits: UsagePlanLimits;
}) {
  const { usage, projectUsage, pendingDays, isFilling } = useUsageFill(
    organizationSlug,
    month,
    initial
  );
  const location = useOptimisticLocation();
  const { replace } = useSearchParams();
  const projects = projectUsage.ok ? usageProjects(projectUsage.value) : [];
  const state = parseUsagePageState(
    new URLSearchParams(location.search),
    projects.map((project) => project.id)
  );

  const hasRestored = useRef(false);
  useEffect(() => {
    if (hasRestored.current) return;
    hasRestored.current = true;

    const restore = storedGroupingsToRestore(
      new URLSearchParams(location.search),
      browserGroupingsStore()
    );
    if (Object.keys(restore).length > 0) replace(restore);
  }, [location.search, replace]);

  const changeGroupings = (param: GroupingsParam, groupings: UsageDimension[]) => {
    writeStoredGroupings(browserGroupingsStore(), param, groupings);
    replace({ [USAGE_PAGE_PARAMS[param]]: groupings.join(",") });
  };

  const active = { usage, projects: projectUsage, addons: addOns }[state.tab];
  const fetchedAt = active.ok ? active.value.fetchedAt : undefined;

  return (
    <MetricsLayout.Root>
      <MetricsLayout.Filters>
        <TabContainer>
          {TABS.map((tab) => (
            <TabButton
              key={tab.value}
              layoutId="billing-usage-tabs"
              isActive={state.tab === tab.value}
              onClick={() => replace({ [USAGE_PAGE_PARAMS.tab]: tab.value })}
            >
              {tab.label}
            </TabButton>
          ))}
        </TabContainer>
        <div className="flex items-center gap-2">
          {state.tab === "projects" && projects.length > 0 && (
            <Select
              name="project"
              value={state.project}
              setValue={(value) => replace({ [USAGE_PAGE_PARAMS.project]: value })}
              items={[
                { value: ALL_PROJECTS, label: "All projects" },
                ...projects.map((project) => ({ value: project.id, label: project.name })),
              ]}
              text={(value) =>
                projects.find((project) => project.id === value)?.name ?? "All projects"
              }
              dropdownIcon
              variant="tertiary/small"
            >
              {(items) =>
                items.map((item) => (
                  <SelectItem key={item.value} value={item.value}>
                    {item.label}
                  </SelectItem>
                ))
              }
            </Select>
          )}
          {pendingDays > 0 && state.tab !== "addons" && (
            <div className="flex items-center gap-1.5 whitespace-nowrap">
              {isFilling && <Spinner className="size-3.5" color="muted" />}
              <Paragraph variant="extra-small">
                {isFilling ? "Loading" : "Couldn't load"} {pendingDays} earlier{" "}
                {pendingDays === 1 ? "day" : "days"}
              </Paragraph>
            </div>
          )}
          {fetchedAt && (
            <Paragraph variant="extra-small" className="whitespace-nowrap">
              Updated <DateTime date={fetchedAt} />
            </Paragraph>
          )}
          <MonthStepper
            months={months}
            month={month}
            onChange={(value) => replace({ [USAGE_PAGE_PARAMS.month]: value })}
          />
        </div>
      </MetricsLayout.Filters>
      {state.tab === "usage" ? (
        usage.ok ? (
          <UsageTab
            usage={usage.value}
            isFilling={isFilling}
            limits={limits}
            groupings={state.usageGroupings}
            onGroupingsChange={(groupings) => changeGroupings("usageGroupings", groupings)}
          />
        ) : (
          <ErrorGrid result={usage} />
        )
      ) : state.tab === "addons" ? (
        addOns.ok ? (
          <AddOnsTab addOns={addOns.value} />
        ) : (
          <ErrorGrid result={addOns} />
        )
      ) : projectUsage.ok ? (
        <ProjectUsageTab
          usage={projectUsage.value}
          isFilling={isFilling}
          selectedProject={state.project}
          groupings={state.projectGroupings}
          metric={state.metric}
          timeFormat={state.timeFormat}
          onGroupingsChange={(groupings) => changeGroupings("projectGroupings", groupings)}
          onMetricChange={(metric) => replace({ [USAGE_PAGE_PARAMS.metric]: metric })}
          onTimeFormatChange={(timeFormat) =>
            replace({ [USAGE_PAGE_PARAMS.timeFormat]: timeFormat })
          }
        />
      ) : (
        <ErrorGrid result={projectUsage} />
      )}
    </MetricsLayout.Root>
  );
}

function ErrorGrid({ result }: { result: Extract<BillingUsageResult<unknown>, { ok: false }> }) {
  return (
    <MetricsLayout.Grid columns={{ base: 1 }}>
      <BillingUsageErrorPanel error={result.error} retryable={result.retryable} />
    </MetricsLayout.Grid>
  );
}
