import {
  type DeploymentResourceItems,
  DeploymentResources,
} from "~/components/deployments/DeploymentResources";
import {
  ArrowPathIcon,
  BeakerIcon,
  BellIcon,
  BookOpenIcon,
  ClipboardDocumentIcon,
  KeyIcon,
  NoSymbolIcon,
  PaperAirplaneIcon,
  PauseIcon,
} from "@heroicons/react/20/solid";
import { type ReactNode, useState } from "react";
import { CubeSparkleIcon } from "~/assets/icons/CubeSparkleIcon";
import { DeploymentsIcon } from "~/assets/icons/DeploymentsIcon";
import { ListCheckedIcon } from "~/assets/icons/ListCheckedIcon";
import { RunsIcon } from "~/assets/icons/RunsIcon";
import { TasksIcon } from "~/assets/icons/TasksIcon";
import { WebhookIcon } from "~/assets/icons/WebhookIcon";
import { BuildLogsViewer } from "~/components/deployments/BuildLogsViewer";
import { EnvironmentCombo } from "~/components/environments/EnvironmentLabel";
import { Badge } from "~/components/primitives/Badge";
import { Button, LinkButton } from "~/components/primitives/Buttons";
import { type ChartConfig } from "~/components/primitives/charts/Chart";
import { Chart } from "~/components/primitives/charts/ChartCompound";
import { CopyableText } from "~/components/primitives/CopyableText";
import {
  type DetailTab,
  DetailHeader,
  DetailPageTitle,
  DetailMain,
  DetailPage,
  DetailProperty,
  DetailTabs,
  PropertyGroup,
  PropertyPair,
  PropertyRail,
} from "~/components/primitives/detail/DetailPage";
import {
  ActivityTimeline,
  DangerZone,
  DetailSection,
  DetailSectionHeading,
  DetailTabEmpty,
  DetailTabError,
  DetailTableTab,
  DetailTabLoading,
  ChartSkeleton,
  ProgressMeter,
  SettingGroup,
  SettingRow,
} from "~/components/primitives/detail/DetailSections";
import { NavBar, PageAccessories } from "~/components/primitives/PageHeader";
import {
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
} from "~/components/primitives/Table";
import { BulkActionStatusCombo, BulkActionTypeCombo } from "~/components/runs/v3/BulkAction";
import { BulkActionFilterList } from "~/components/runs/v3/BulkActionFilterList";
import type { DeploymentLogEntry } from "~/components/runs/v3/deploymentLogsCache";
import { DeploymentStatus } from "~/components/runs/v3/DeploymentStatus";
import { TaskRunStatusCombo } from "~/components/runs/v3/TaskRunStatus";
import { EndpointStatusBadge } from "~/components/webhookEndpoints/v1/EndpointStatus";
import { cn } from "~/utils/cn";
import { StoryPage, StorySection, StorySubSection } from "../storybook/StoryKit";
import { ScheduleStory } from "./ScheduleStories";

/* The detail page template (components/primitives/detail) with static data. Each entity has its
   own tabs: no page assumes an Overview or an Activity tab. Tables run edge to edge. */
export default function Story() {
  return (
    <StoryPage
      title="Detail pages"
      componentNames={["DetailPage.tsx", "DetailSections.tsx", "BuildLogsViewer.tsx"]}
      description="One detail template for deployments, tasks, bulk actions and webhook endpoints: a header that owns identity and actions, the entity's own tabs, a main column for the selected tab, and a property rail. Tables in the main column run edge to edge."
    >
      <StorySection
        title="Deployment"
        description="Overview: what the deploy contains, the runs on it, and how it's doing against the previous version. Tabs: Overview, Tasks, Runs, Build logs, Activity."
      >
        <Frame>
          <DeploymentPage />
        </Frame>
      </StorySection>
      <StorySection
        title="Deployment: Build logs"
        description="A failed deploy. The error count jumps to the first error; search filters lines and highlights matches."
      >
        <Frame>
          <DeploymentPage failed initialTab="logs" />
        </Frame>
      </StorySection>
      <StorySection
        title="Deployment: Activity"
        description="Only deployments have an Activity tab. The callout says what went wrong and how to fix it."
      >
        <Frame>
          <DeploymentPage failed initialTab="activity" />
        </Frame>
      </StorySection>
      <StorySection
        title="Task"
        description="Tabs: Runs, Queue, Schedules. No Overview or Activity."
      >
        <Frame>
          <TaskPage />
        </Frame>
      </StorySection>
      <StorySection
        title="Task: Queue"
        description="Concurrency slots and the queue's backlog, with the queue actions beside them; the queued runs below."
      >
        <Frame>
          <TaskPage initialTab="queue" />
        </Frame>
      </StorySection>
      <StorySection
        title="Schedules: schedule page"
        description="Each schedule has its own page on the detail template, opened from a row on the scheduled task's Schedules tab: Upcoming and Runs tabs, its settings in the rail, Disable, Delete and Edit in the header. Upcoming is a calendar beside a day: six weeks from this week (then a month at a time), each day with when its runs start and end, how many, and a midnight-to-midnight bar; the picked day's runs are the table beside it. Create and Edit are a centered dialog with the next runs previewed beside the form."
      >
        <Frame>
          <ScheduleStory />
        </Frame>
      </StorySection>
      <StorySection
        title="Schedules: Upcoming, a year of months"
        description="A schedule that runs on only a few days (monthly, quarterly) opens Upcoming on twelve small months instead of six weeks. A month's name opens that month. On the real page the calendar pages with ?month=, a day is picked with ?day= and Month or Year is forced with ?view=; here the data is static."
      >
        <Frame>
          <ScheduleStory sparse />
        </Frame>
      </StorySection>
      <StorySection
        title="Schedules: Upcoming, a dense schedule"
        description="A schedule that runs every day around the clock (every minute up to every six hours) has no calendar: no day differs from the next. Upcoming shows its rhythm instead, as lanes from now at three zoom levels (the next hour, 24 hours and 7 days for this one) over the day's runs. A daylight saving change is a sun on the lane it falls in and in the row under the lanes."
      >
        <Frame>
          <ScheduleStory dense />
        </Frame>
      </StorySection>
      <StorySection
        title="Agent"
        description="An agent is a task with a Sessions tab first, the Playground as its main action, and the models it called in the rail. Sessions sit beside their LLM spend and tokens."
      >
        <Frame>
          <AgentPage />
        </Frame>
      </StorySection>
      <StorySection
        title="Bulk action"
        description="In progress. Tabs: Runs and Failed. Progress sits at the top of the rail, above Details."
      >
        <Frame>
          <BulkActionPage />
        </Frame>
      </StorySection>
      <StorySection
        title="Webhook endpoint"
        description="Tabs: Deliveries, Subscribers, Waiters, Settings."
      >
        <Frame>
          <WebhookPage />
        </Frame>
      </StorySection>
      <StorySection
        title="Webhook endpoint: Settings"
        description="Rotate sits on the signing secret row. Disable is unavailable while deliveries are replaying."
      >
        <Frame>
          <WebhookPage initialTab="settings" />
        </Frame>
      </StorySection>
      <StorySection
        title="Narrow width"
        description="Below 900px of page width the rail closes and Details opens it as a sheet. Secondary actions fold into the more menu below 1100px."
      >
        <Frame width="w-[768px]" height="h-[560px]">
          <TaskPage />
        </Frame>
      </StorySection>

      <StorySection title="DetailHeader" componentName="DetailPage.tsx">
        <div className="flex flex-col gap-3">
          <StorySubSection title="With status, badge and a primary action">
            <HeaderFrame>
              <DeploymentHeader />
            </HeaderFrame>
          </StorySubSection>
          <StorySubSection title="Mono title, no status">
            <HeaderFrame>
              <TaskHeader />
            </HeaderFrame>
          </StorySubSection>
          <StorySubSection title="Truncated title, disabled action with a tooltip">
            <HeaderFrame>
              <BulkHeader />
            </HeaderFrame>
          </StorySubSection>
        </div>
      </StorySection>

      <StorySection title="DetailTabs" componentName="DetailPage.tsx">
        <TabsDemo />
      </StorySection>

      <StorySection title="PropertyRail" componentName="DetailPage.tsx">
        <div className="h-[420px] w-[320px] overflow-hidden rounded-sm border border-grid-bright">
          <DeploymentRail />
        </div>
      </StorySection>

      <StorySection title="ProgressMeter" componentName="DetailSections.tsx">
        <div className="flex max-w-[640px] flex-col gap-6">
          <ProgressMeter
            total={1284}
            segments={[
              { count: 890, label: "replayed successfully", className: "bg-success" },
              { count: 22, label: "failed", className: "bg-error" },
            ]}
          />
          <ProgressMeter
            total={6}
            segments={[
              { count: 3, label: "canceled", className: "bg-success" },
              { count: 3, label: "already finished", className: "bg-surface-control-hover" },
              { count: 0, label: "failed", className: "bg-error" },
            ]}
          />
        </div>
      </StorySection>

      <StorySection title="ActivityTimeline" componentName="DetailSections.tsx">
        <div className="grid max-w-[1000px] grid-cols-2 gap-8">
          <StorySubSection title="Deployed and promoted">
            <ActivityTimeline steps={deploySteps} />
          </StorySubSection>
          <StorySubSection title="Failed, with a callout and inline logs">
            <ActivityTimeline failure={deployFailure} steps={failedDeploySteps} />
          </StorySubSection>
        </div>
      </StorySection>

      <StorySection title="SettingRow and DangerZone" componentName="DetailSections.tsx">
        <WebhookSettings />
      </StorySection>

      <StorySection
        title="Tab states"
        componentName="DetailSections.tsx"
        description="The tab bar and the rail stay put; only the main column changes. Loading rows run edge to edge like the table they stand in for."
      >
        <div className="grid grid-cols-3 gap-4">
          {(["Loading", "Empty", "Error"] as const).map((state) => (
            <div key={state} className="flex flex-col gap-2">
              <span className="text-xs text-text-dimmed">{state}</span>
              <div className="overflow-hidden rounded-sm border border-grid-bright bg-background-dimmed">
                <DetailTabs
                  tabs={stateTabs}
                  activeTab="deliveries"
                  onTabChange={() => {}}
                  layoutId={`state-${state}`}
                />
                {state === "Loading" ? (
                  <DetailTabLoading
                    columns={[
                      { label: "Delivery" },
                      { label: "Event" },
                      { label: "Status" },
                      { label: "Received", alignment: "right" },
                    ]}
                    rows={5}
                  />
                ) : state === "Empty" ? (
                  <DetailTabEmpty
                    title="No deliveries yet"
                    description="Deliveries show up here once the provider sends its first event to this endpoint."
                    action={
                      <Button variant="primary/small" LeadingIcon={PaperAirplaneIcon}>
                        Send test event
                      </Button>
                    }
                  />
                ) : (
                  <DetailTabError
                    title="Couldn't load deliveries"
                    cause="The request timed out after 30s. Your deliveries are safe. Try again, or narrow the time period."
                    onRetry={() => {}}
                  />
                )}
              </div>
            </div>
          ))}
        </div>
      </StorySection>

      <StorySection
        title="Loading skeletons"
        componentName="DetailSections.tsx"
        description="What a tab shows while its slow data streams in: the real table header with placeholder rows, the runs chart's frame with bars, and the Health cells with their labels. The shimmer is one band across the page; with reduced motion it's flat grey."
      >
        <div className="flex flex-col gap-6">
          <StorySubSection title="Runs tab">
            <div className="overflow-hidden rounded-sm border border-grid-bright bg-background-dimmed">
              <DetailTabLoading
                columns={[
                  { label: "ID" },
                  { label: "Task" },
                  { label: "Status" },
                  { label: "Version" },
                  { label: "Started" },
                  { label: "Duration" },
                  { label: "Machine" },
                ]}
                rows={6}
              />
            </div>
          </StorySubSection>
          <StorySubSection title="Runs chart">
            <div className="h-40">
              <ChartSkeleton />
            </div>
          </StorySubSection>
        </div>
      </StorySection>
    </StoryPage>
  );
}

/** A 1:1 page frame: the nav bar and the page under it, at a fixed height. */
function Frame({
  children,
  width = "w-full",
  height = "h-[700px]",
}: {
  children: ReactNode;
  width?: string;
  height?: string;
}) {
  return (
    <div className="max-w-full overflow-x-auto">
      <div
        className={`${width} ${height} grid grid-rows-[auto_minmax(0,1fr)] overflow-hidden rounded-sm border border-grid-bright`}
      >
        {children}
      </div>
    </div>
  );
}

function HeaderFrame({ children }: { children: ReactNode }) {
  return <div className="overflow-hidden rounded-sm border border-grid-bright">{children}</div>;
}

function Nav({ back, title, docs }: { back: string; title: string; docs?: string }) {
  return (
    <NavBar>
      <DetailPageTitle title={title} backButton={{ to: "#", text: back }} />
      {docs ? (
        <PageAccessories>
          <LinkButton variant="docs/small" LeadingIcon={BookOpenIcon} to="#">
            {docs}
          </LinkButton>
        </PageAccessories>
      ) : null}
    </NavBar>
  );
}

const prod = { type: "PRODUCTION" as const };

// ---------- deployment ----------

type DeployTab = "overview" | "tasks" | "runs" | "logs" | "activity";

function DeploymentHeader({ failed = false }: { failed?: boolean }) {
  return failed ? (
    <DetailHeader
      icon={DeploymentsIcon}
      iconClassName="text-deployments"
      title="20261117.4"
      status={<DeploymentStatus status="FAILED" isBuilt={false} />}
      meta={[
        <EnvironmentCombo key="env" environment={prod} className="text-xs text-text-dimmed" />,
        <span key="git">
          feat/statement-pdf · <code className="font-mono">a81d4e0</code>
        </span>,
        <span key="by">Started 9m ago by Maya Ortiz</span>,
      ]}
      friendlyId="deployment_p4w8c2n6zr"
      primaryAction={
        <Button variant="primary/small" LeadingIcon={ArrowPathIcon}>
          Redeploy…
        </Button>
      }
    />
  ) : (
    <DetailHeader
      icon={DeploymentsIcon}
      iconClassName="text-deployments"
      title="20261117.3"
      badges={<Badge variant="extra-small">Current</Badge>}
      status={<DeploymentStatus status="DEPLOYED" isBuilt />}
      meta={[
        <EnvironmentCombo key="env" environment={prod} className="text-xs text-text-dimmed" />,
        <span key="git">
          main · <code className="font-mono">3f9c2ab</code>
        </span>,
        <span key="by">Deployed 2h ago by Maya Ortiz</span>,
      ]}
      friendlyId="deployment_b7k2m9x4q1"
      secondaryActions={
        <LinkButton
          variant="secondary/small"
          LeadingIcon={RunsIcon}
          leadingIconClassName="text-runs"
          to="#"
        >
          View runs
        </LinkButton>
      }
      primaryAction={
        <Button variant="primary/small" LeadingIcon={ArrowPathIcon}>
          Redeploy…
        </Button>
      }
    />
  );
}

function DeploymentRail({ failed = false }: { failed?: boolean }) {
  return (
    <PropertyRail>
      <PropertyGroup title="Details">
        <PropertyPair>
          <DetailProperty label="ID">
            <CopyableText
              value={failed ? "deployment_p4w8c2n6zr" : "deployment_b7k2m9x4q1"}
              className="font-mono text-xs"
              truncate
            />
          </DetailProperty>
          <DetailProperty label="Status">
            {failed ? (
              <DeploymentStatus status="FAILED" isBuilt={false} />
            ) : (
              <DeploymentStatus status="DEPLOYED" isBuilt />
            )}
          </DetailProperty>
          <DetailProperty label="Environment">
            <EnvironmentCombo environment={prod} />
          </DetailProperty>
          <DetailProperty label="Created">
            {failed ? "Nov 17, 14:31" : "Nov 17, 14:02"}
          </DetailProperty>
        </PropertyPair>
      </PropertyGroup>
      <PropertyGroup title="Build">
        <PropertyPair>
          <DetailProperty label="Version">{failed ? "20261117.4" : "20261117.3"}</DetailProperty>
          <DetailProperty label="Build time">{failed ? "1m 48s" : "1m 52s"}</DetailProperty>
          <DetailProperty label="Image size">{failed ? "214 MB" : "208 MB"}</DetailProperty>
          <DetailProperty label="Worker type">Managed</DetailProperty>
        </PropertyPair>
      </PropertyGroup>
      <PropertyGroup title="Runtime">
        <PropertyPair>
          <DetailProperty label="SDK version">4.3.1</DetailProperty>
          <DetailProperty label="CLI version">4.3.1</DetailProperty>
          <DetailProperty label="Runtime">Node 22.12.0</DetailProperty>
          <DetailProperty label="Platform">linux/amd64</DetailProperty>
        </PropertyPair>
      </PropertyGroup>
      <PropertyGroup title="Source">
        <DetailProperty label="Git">
          {failed
            ? "feat/statement-pdf · a81d4e0 Add PDF statements"
            : "main · 3f9c2ab Retry invoice sync on 429 responses from the mail provider"}
        </DetailProperty>
        <PropertyPair>
          <DetailProperty label="Deployed by">Maya Ortiz</DetailProperty>
          <DetailProperty label="Triggered via">{failed ? "CLI" : "GitHub Actions"}</DetailProperty>
        </PropertyPair>
      </PropertyGroup>
    </PropertyRail>
  );
}

const deployFailure = {
  title: "Indexing failed: two tasks share the id generate-monthly-statement",
  description: (
    <>
      Rename one of them in <code className="font-mono">src/trigger/statements.ts</code> or{" "}
      <code className="font-mono">src/trigger/pdf.ts</code>, then redeploy. 20261117.3 is still
      current and serving runs.
    </>
  ),
};

const deploySteps = [
  {
    status: "ok" as const,
    title: "Queued",
    description: "Picked up by the build server",
    time: "14:02:11 · 3s",
  },
  {
    status: "ok" as const,
    title: "Built",
    description: "Image linux/amd64, 208 MB",
    time: "14:02:14 · 1m 52s",
  },
  {
    status: "ok" as const,
    title: "Deployed",
    description: "14 tasks indexed",
    time: "14:04:06 · 25s",
  },
  {
    status: "ok" as const,
    title: "Promoted to current",
    description: "Replaced 20261117.2 for new runs",
    time: "14:04:31",
  },
];

const failedDeploySteps = [
  {
    status: "ok" as const,
    title: "Queued",
    description: "Picked up by the build server",
    time: "14:31:02 · 4s",
  },
  {
    status: "ok" as const,
    title: "Installing",
    description: "pnpm install, 812 packages",
    time: "14:31:06 · 41s",
  },
  {
    status: "ok" as const,
    title: "Building",
    description: "Image linux/amd64, 214 MB",
    time: "14:31:47 · 1m 48s",
  },
  {
    status: "fail" as const,
    title: "Indexing failed",
    description: "The worker started but task registration was rejected",
    time: "14:33:35 · 1s",
    logs: (
      <>
        <span className="text-text-faint">14:33:35</span> Indexing 15 tasks from 9 files{"\n"}
        <span className="text-error">
          14:33:36 Error: Duplicate task id "generate-monthly-statement"
        </span>
        {"\n"}
        <span className="text-error">
          {"         "}at src/trigger/statements.ts:12 and src/trigger/pdf.ts:40
        </span>
      </>
    ),
  },
  {
    status: "pending" as const,
    title: "Deploying",
    description: "Skipped because indexing failed",
  },
];

function DeploymentPage({
  failed = false,
  initialTab = "overview",
}: {
  failed?: boolean;
  initialTab?: DeployTab;
}) {
  const [tab, setTab] = useState<DeployTab>(initialTab);
  const tabs: DetailTab<DeployTab>[] = [
    { id: "overview", label: "Overview" },
    { id: "tasks", label: "Tasks", count: failed ? "0" : "14" },
    { id: "runs", label: "Runs", count: failed ? "0" : "3,117" },
    { id: "logs", label: "Build logs" },
    { id: "activity", label: "Activity" },
  ];

  return (
    <>
      <Nav back="Deploys" title={failed ? "20261117.4" : "20261117.3"} docs="Deploy docs" />
      <DetailPage
        id="story-deployment"
        header={<DeploymentHeader failed={failed} />}
        tabs={
          <DetailTabs
            tabs={tabs}
            activeTab={tab}
            onTabChange={setTab}
            layoutId={`deploy-${failed}-${initialTab}`}
            tools={tab === "overview" && !failed ? <PeriodChip value="24h" /> : undefined}
          />
        }
        rail={<DeploymentRail failed={failed} />}
      >
        {tab === "logs" ? (
          <BuildLogsViewer
            logs={failed ? failedBuildLogs : buildLogs}
            downloadName={`${failed ? "20261117.4" : "20261117.3"}-build.log`}
          />
        ) : tab === "activity" ? (
          <DetailMain>
            <ActivityTimeline
              failure={failed ? deployFailure : undefined}
              steps={failed ? failedDeploySteps : deploySteps}
            />
          </DetailMain>
        ) : failed ? (
          <DetailTabEmpty
            title={
              tab === "overview"
                ? "This deploy failed while indexing"
                : tab === "tasks"
                  ? "No tasks indexed"
                  : "No runs on this version"
            }
            description="Two tasks share the id generate-monthly-statement. 20261117.3 is still current."
            action={
              <Button variant="secondary/small" onClick={() => setTab("logs")}>
                View build logs
              </Button>
            }
          />
        ) : tab === "overview" ? (
          <DetailMain>
            <StatusChart
              title="Runs on this version"
              data={deployChartData}
              config={runsChartConfig}
            />
            <DeployCounts />
          </DetailMain>
        ) : tab === "tasks" ? (
          <DetailTableTab
            tools={<SearchChip placeholder="Search tasks" />}
            actions={
              <span className="text-xs text-text-dimmed">1 added, 0 removed since 20261117.2</span>
            }
          >
            <StoryTable
              headers={["Task", "File", "Queue", "Runs (24h)", "Failure rate", "Avg duration"]}
              rows={deployTasks.map((task) => [
                <span key="id" className="flex items-center gap-2">
                  {task.id}
                  {task.added ? <Badge variant="extra-small">New</Badge> : null}
                </span>,
                task.file,
                task.queue,
                task.runs,
                <span key="rate" className={cn(task.failing && "text-error")}>
                  {task.rate}
                </span>,
                task.duration,
              ])}
              alignRight={[3, 4, 5]}
            />
          </DetailTableTab>
        ) : (
          <DetailTableTab
            tools={<FilterChip label="Status" value="Any" />}
            actions={
              <LinkButton
                variant="tertiary/small"
                to="#"
                LeadingIcon={RunsIcon}
                leadingIconClassName="text-runs"
              >
                Open in runs list
              </LinkButton>
            }
          >
            <RunsTable />
          </DetailTableTab>
        )}
      </DetailPage>
    </>
  );
}

/** What this version registered, with the change since the previous one. */
function DeployCounts() {
  const base = {
    tasks: 14,
    scheduled: 3,
    agents: 1,
    webhookTasks: 0,
    queues: 6,
    concurrencyLimits: 2,
    declaredSchedules: 2,
    webhookEndpoints: 2,
    webhookSubscribers: 3,
    machinePresets: 2,
    files: 9,
  };
  return (
    <DeploymentResources
      counts={base}
      previous={{ ...base, tasks: 13, agents: 0, queues: 7 }}
      items={MOCK_RESOURCES}
      prompts={MOCK_PROMPTS}
      taskPath={() => "#"}
    />
  );
}

const mockTask = (
  slug: string,
  filePath: string,
  triggerSource: DeploymentResourceItems["tasks"][number]["triggerSource"] = "STANDARD",
  extra: Partial<DeploymentResourceItems["tasks"][number]> = {}
): DeploymentResourceItems["tasks"][number] => ({
  slug,
  filePath,
  triggerSource,
  queue: `task/${slug}`,
  machine: null,
  maxDurationSeconds: null,
  maxAttempts: null,
  change: null,
  ...extra,
});

const MOCK_RESOURCES: DeploymentResourceItems = {
  tasks: [
    mockTask("generate-invoice", "src/trigger/billing.ts", "STANDARD", {
      queue: "billing",
      machine: "small-2x",
      maxDurationSeconds: 300,
      maxAttempts: 5,
    }),
    mockTask("send-invoice-email", "src/trigger/billing.ts", "STANDARD", { queue: "billing" }),
    mockTask("nightly-usage-rollup", "src/trigger/usage.ts", "SCHEDULED", {
      machine: "medium-1x",
      maxDurationSeconds: 3600,
    }),
    mockTask("hourly-sync", "src/trigger/sync.ts", "SCHEDULED", { maxAttempts: 3 }),
    mockTask("weekly-digest", "src/trigger/digest.ts", "SCHEDULED"),
    mockTask("support-agent", "src/trigger/agent.ts", "AGENT", {
      machine: "small-2x",
      change: "added",
    }),
    mockTask("resize-image", "src/trigger/media.ts", "STANDARD", {
      queue: "media",
      machine: "medium-1x",
      maxDurationSeconds: 120,
    }),
    mockTask("transcode-video", "src/trigger/media.ts", "STANDARD", {
      queue: "media",
      machine: "medium-1x",
      maxDurationSeconds: 1800,
      maxAttempts: 2,
    }),
    mockTask("import-csv", "src/trigger/imports.ts", "STANDARD", { change: "added" }),
    mockTask("parse-row", "src/trigger/imports.ts"),
    mockTask("enrich-contact", "src/trigger/crm.ts", "STANDARD", { maxAttempts: 10 }),
    mockTask("sync-hubspot", "src/trigger/crm.ts"),
    mockTask("cleanup-temp-files", "src/trigger/maintenance.ts"),
    mockTask("notify-slack", "src/trigger/notify.ts"),
    mockTask("legacy-export", "src/trigger/export.ts", "STANDARD", { change: "removed" }),
  ],
  queues: [
    {
      name: "billing",
      concurrencyLimit: 5,
      tasks: ["generate-invoice", "send-invoice-email"],
      change: null,
    },
    {
      name: "media",
      concurrencyLimit: 10,
      tasks: ["resize-image", "transcode-video"],
      change: null,
    },
    {
      name: "task/nightly-usage-rollup",
      concurrencyLimit: 1,
      tasks: ["nightly-usage-rollup"],
      change: null,
    },
    { name: "task/import-csv", concurrencyLimit: null, tasks: ["import-csv"], change: "added" },
    {
      name: "task/enrich-contact",
      concurrencyLimit: null,
      tasks: ["enrich-contact"],
      change: null,
    },
    {
      name: "task/support-agent",
      concurrencyLimit: null,
      tasks: ["support-agent"],
      change: "added",
    },
    { name: "exports", concurrencyLimit: 2, tasks: [], change: "removed" },
  ],
  concurrencyLimits: [
    {
      name: "openai",
      concurrencyLimit: 20,
      tasks: ["support-agent", "enrich-contact"],
      change: null,
    },
    { name: "hubspot-api", concurrencyLimit: 4, tasks: ["sync-hubspot"], change: null },
  ],
  schedules: [
    { taskId: "nightly-usage-rollup", cron: "0 2 * * *", timezone: "Europe/London", change: null },
    { taskId: "hourly-sync", cron: "0 * * * *", timezone: "UTC", change: null },
  ],
  webhookEndpoints: [
    {
      id: "stripe",
      source: "stripe",
      filePath: "src/trigger/webhooks.ts",
      subscribers: ["generate-invoice", "send-invoice-email"],
      change: null,
    },
    {
      id: "github",
      source: "github",
      filePath: "src/trigger/webhooks.ts",
      subscribers: ["notify-slack"],
      change: null,
    },
  ],
  machines: [
    { name: null, tasks: 9 },
    { name: "medium-1x", tasks: 3 },
    { name: "small-2x", tasks: 2 },
  ],
};

/** Already resolved: the Prompts row draws without its placeholder. */
const MOCK_PROMPTS = Promise.resolve([
  { slug: "support-agent-system", version: 4, model: "claude-sonnet-5-5" },
]);

const deployTasks = [
  {
    id: "send-invoice-reminder",
    file: "src/trigger/invoices.ts",
    queue: "task/send-invoice-reminder",
    runs: "1,942",
    rate: "1.8%",
    duration: "3.1s",
    failing: true,
  },
  {
    id: "sync-ledger-entries",
    file: "src/trigger/ledger.ts",
    queue: "ledger",
    runs: "864",
    rate: "0.2%",
    duration: "12.4s",
  },
  {
    id: "generate-monthly-statement",
    file: "src/trigger/statements.ts",
    queue: "statements",
    runs: "311",
    rate: "0.0%",
    duration: "48.0s",
  },
  {
    id: "render-receipt-pdf",
    file: "src/trigger/pdf.ts",
    queue: "statements",
    runs: "0",
    rate: "–",
    duration: "–",
    added: true,
  },
  {
    id: "stripe-webhook-router",
    file: "src/trigger/stripe.ts",
    queue: "webhooks",
    runs: "0",
    rate: "0.0%",
    duration: "0.4s",
  },
  {
    id: "nightly-usage-rollup",
    file: "src/trigger/usage.ts",
    queue: "task/nightly-usage-rollup",
    runs: "1",
    rate: "0.0%",
    duration: "2m 10s",
  },
  {
    id: "notify-overdue-accounts",
    file: "src/trigger/invoices.ts",
    queue: "task/notify-overdue-accounts",
    runs: "0",
    rate: "–",
    duration: "–",
  },
  {
    id: "support-agent",
    file: "src/trigger/agent.ts",
    queue: "agents",
    runs: "0",
    rate: "–",
    duration: "–",
  },
];

const at = (seconds: number) => new Date(Date.UTC(2026, 10, 17, 14, 2, 11) + seconds * 1000);

const buildLogs: DeploymentLogEntry[] = [
  ["info", 0, "Deploying project proj_mbxkzt3w to prod"],
  ["info", 1, "Using trigger.dev CLI 4.3.1, SDK 4.3.1"],
  ["info", 2, "Building image for linux/amd64"],
  ["info", 4, "#1 [internal] load build definition from Containerfile"],
  ["info", 5, "#4 [base 1/4] FROM node:22.12.0-bookworm-slim"],
  ["info", 9, "#7 [build 2/5] RUN pnpm install --frozen-lockfile"],
  ["info", 48, "#7 Packages: +812"],
  ["warn", 49, "#7 WARN deprecated inflight@1.0.6: This module is not supported, and leaks memory"],
  ["info", 50, "#7 Done in 41.2s"],
  ["info", 51, "#9 [build 4/5] RUN node build.mjs"],
  ["info", 86, "#9 Bundled 9 entry points, 14 tasks"],
  ["info", 104, "#12 exporting layers 208 MB"],
  ["info", 112, "#12 pushing image to registry done"],
  ["info", 113, "Image built in 1m 52s"],
  ["info", 114, "Indexing tasks"],
  ["info", 136, "Indexed 14 tasks, 6 queues, 3 schedules, 2 webhooks, 1 agent"],
  ["info", 139, "Deployed 20261117.3"],
  ["info", 140, "Promoted 20261117.3 to current"],
].map(([level, seconds, message]) => ({
  level: level as DeploymentLogEntry["level"],
  timestamp: at(seconds as number),
  message: message as string,
}));

const failedBuildLogs: DeploymentLogEntry[] = [
  ["info", 0, "Deploying project proj_mbxkzt3w to prod"],
  ["info", 1, "Using trigger.dev CLI 4.3.1, SDK 4.3.1"],
  ["info", 2, "Building image for linux/amd64"],
  ["info", 4, "#1 [internal] load build definition from Containerfile"],
  ["info", 5, "#4 [base 1/4] FROM node:22.12.0-bookworm-slim"],
  ["info", 9, "#7 [build 2/5] RUN pnpm install --frozen-lockfile"],
  ["info", 47, "#7 Packages: +812"],
  ["warn", 48, "#7 WARN deprecated inflight@1.0.6: This module is not supported, and leaks memory"],
  ["warn", 48, "#7 WARN 2 peer dependency issues: pdfkit@0.15.0 wants fontkit@^2"],
  ["info", 50, "#7 Done in 41.0s"],
  ["info", 51, "#9 [build 4/5] RUN node build.mjs"],
  ["info", 84, "#9 Bundled 9 entry points, 15 tasks"],
  ["info", 101, "#12 exporting layers 214 MB"],
  ["info", 108, "#12 pushing image to registry done"],
  ["info", 109, "Image built in 1m 48s"],
  ["info", 153, "Indexing 15 tasks from 9 files"],
  ["info", 154, "Registered send-invoice-reminder, sync-ledger-entries, +11 more"],
  ["error", 154, 'Error: Duplicate task id "generate-monthly-statement"'],
  ["error", 154, "    at src/trigger/statements.ts:12 and src/trigger/pdf.ts:40"],
  ["info", 154, "Deploy marked as failed. 20261117.3 is still current."],
].map(([level, seconds, message]) => ({
  level: level as DeploymentLogEntry["level"],
  timestamp: at((seconds as number) + 1731),
  message: message as string,
}));

// ---------- task ----------

type TaskTab = "runs" | "queue" | "schedules";

function TaskHeader() {
  return (
    <DetailHeader
      icon={TasksIcon}
      iconClassName="text-tasks"
      title="send-invoice-reminder"
      mono
      meta={["Standard task", "Version 20261117.3", "3 running, 12 queued"]}
      friendlyId="send-invoice-reminder"
      secondaryActions={
        <>
          <Button
            variant="secondary/small"
            LeadingIcon={BellIcon}
            leadingIconClassName="text-alerts"
          >
            Watch
          </Button>
          <LinkButton
            variant="secondary/small"
            to="#"
            LeadingIcon={RunsIcon}
            leadingIconClassName="text-runs"
          >
            View runs
          </LinkButton>
        </>
      }
      primaryAction={
        <Button variant="primary/small" LeadingIcon={BeakerIcon}>
          Test task
        </Button>
      }
    />
  );
}

function TaskPage({ initialTab = "runs" }: { initialTab?: TaskTab }) {
  const [tab, setTab] = useState<TaskTab>(initialTab);
  const tabs: DetailTab<TaskTab>[] = [
    { id: "runs", label: "Runs", count: "2,018" },
    { id: "queue", label: "Queue", count: "12" },
    { id: "schedules", label: "Schedules", count: "1" },
  ];

  return (
    <>
      <Nav back="Tasks" title="send-invoice-reminder" docs="Task docs" />
      <DetailPage
        id="story-task"
        header={<TaskHeader />}
        tabs={
          <DetailTabs
            tabs={tabs}
            activeTab={tab}
            onTabChange={setTab}
            layoutId={`task-${initialTab}`}
          />
        }
        rail={
          <PropertyRail>
            <PropertyGroup title="Details">
              <DetailProperty label="Identifier">
                <CopyableText value="send-invoice-reminder" className="font-mono text-xs" />
              </DetailProperty>
              <PropertyPair>
                <DetailProperty label="Type">Standard task</DetailProperty>
                <DetailProperty label="Created">Oct 2, 09:14</DetailProperty>
              </PropertyPair>
              <DetailProperty label="Description">
                Emails a reminder for invoices that are seven days overdue, then schedules a
                follow-up
              </DetailProperty>
            </PropertyGroup>
            <PropertyGroup title="Execution">
              <DetailProperty label="Queue">task/send-invoice-reminder</DetailProperty>
              <PropertyPair>
                <DetailProperty label="Concurrency">3 of 10 running</DetailProperty>
                <DetailProperty label="Machine">small-1x</DetailProperty>
                <DetailProperty label="Max duration">5m</DetailProperty>
                <DetailProperty label="TTL">–</DetailProperty>
              </PropertyPair>
              <DetailProperty label="Retry">
                <div className="flex flex-col gap-1.5">
                  <span>3 attempts</span>
                  <span className="text-xs text-text-dimmed">
                    Waits 1s, then 2s. Backoff ×2, 1s to 30s, each wait up to 2× at random
                  </span>
                </div>
              </DetailProperty>
            </PropertyGroup>
            <PropertyGroup title="Source">
              <DetailProperty label="File path">
                <CopyableText
                  value="src/trigger/invoices.ts"
                  className="font-mono text-xs"
                  truncate
                />
              </DetailProperty>
              <PropertyPair>
                <DetailProperty label="Version">20261117.3</DetailProperty>
                <DetailProperty label="Payload schema">Yes</DetailProperty>
              </PropertyPair>
            </PropertyGroup>
          </PropertyRail>
        }
      >
        {tab === "runs" ? (
          <DetailTableTab
            tools={
              <>
                <PeriodChip value="7d" />
                <FilterChip label="Status" value="Any" />
              </>
            }
            actions={
              <LinkButton
                variant="tertiary/small"
                to="#"
                LeadingIcon={RunsIcon}
                leadingIconClassName="text-runs"
              >
                Open in runs list
              </LinkButton>
            }
          >
            <RunsTable />
          </DetailTableTab>
        ) : tab === "queue" ? (
          <div className="flex h-full flex-col overflow-hidden">
            <QueueSummary />
            <div className="min-h-0 flex-1">
              <DetailTableTab
                tools={
                  <span className="text-xs text-text-dimmed">
                    Waiting to start in task/send-invoice-reminder
                  </span>
                }
              >
                <StoryTable
                  headers={["Run ID", "Status", "Queued for", "Priority", "Version"]}
                  rows={queuedRuns.map(([id, waited, priority]) => [
                    id,
                    <TaskRunStatusCombo key="status" status="PENDING" />,
                    waited,
                    priority,
                    "20261117.3",
                  ])}
                />
              </DetailTableTab>
            </div>
          </div>
        ) : (
          <DetailTableTab
            actions={
              <Button variant="secondary/small" LeadingIcon={PauseIcon}>
                Pause all
              </Button>
            }
          >
            <StoryTable
              headers={["Schedule", "Cron", "Runs", "Next run", "Last run", "Environments"]}
              rows={[
                [
                  "sched_4k8m2x9qwt",
                  <span key="cron" className="flex flex-col">
                    <code className="font-mono text-xs text-text-bright">0 9 * * 1-5</code>
                    <span className="text-xs text-text-dimmed">09:00 on weekdays, UTC</span>
                  </span>,
                  "Declarative",
                  "Tomorrow, 09:00",
                  "Today, 09:00",
                  <EnvironmentCombo key="env" environment={prod} />,
                ],
              ]}
            />
          </DetailTableTab>
        )}
      </DetailPage>
    </>
  );
}

const sessionsChartConfig = {
  active: { label: "Active", color: "var(--color-pending)" },
  closed: { label: "Closed", color: "var(--color-success)" },
} satisfies ChartConfig;

const agentSessionsData = Array.from({ length: 24 }, (_, i) => ({
  bucket: `${String((14 + i) % 24).padStart(2, "0")}:00`,
  closed: [4, 6, 3, 8, 9, 12, 7, 5, 10, 14, 11, 9][i % 12],
  active: i > 20 ? [2, 3, 1][i % 3] : 0,
}));
const agentSpendData = agentSessionsData.map((point) => ({
  bucket: point.bucket,
  spend: (point.closed + point.active) * 0.004,
}));
const agentTokenData = agentSessionsData.map((point) => ({
  bucket: point.bucket,
  tokens: (point.closed + point.active) * 1_850,
}));

function AgentBandPanel({
  label,
  total,
  data,
  config,
  className,
}: {
  label: string;
  total: string;
  data: Record<string, string | number>[];
  config: ChartConfig;
  className?: string;
}) {
  return (
    <div className={cn("flex min-w-0 flex-col gap-1.5 px-3 pb-2 pt-2.5", className)}>
      <div className="flex h-5 items-baseline gap-2">
        <span className="text-xs text-text-dimmed">{label}</span>
        <span className="text-sm font-medium tabular-nums text-text-bright">{total}</span>
      </div>
      <div className="min-h-0 flex-1">
        <Chart.Root config={config} data={data} dataKey="bucket" fillContainer>
          <Chart.Bar stackId="a" barRadius={0} />
        </Chart.Root>
      </div>
    </div>
  );
}

function AgentPage() {
  const [tab, setTab] = useState<"sessions" | "runs" | "queue">("sessions");
  const tabs: DetailTab<"sessions" | "runs" | "queue">[] = [
    { id: "sessions", label: "Sessions" },
    { id: "runs", label: "Runs" },
    { id: "queue", label: "Queue", count: "0" },
  ];

  return (
    <>
      <Nav back="Tasks" title="support-agent" />
      <DetailPage
        id="story-agent"
        header={
          <DetailHeader
            icon={CubeSparkleIcon}
            iconClassName="text-agents"
            title="support-agent"
            mono
            meta={["Agent task", "Version 20261118.3", "2 running, 0 queued"]}
            friendlyId="support-agent"
            secondaryActions={
              <LinkButton
                variant="secondary/small"
                to="#"
                LeadingIcon={RunsIcon}
                leadingIconClassName="text-runs"
              >
                View runs
              </LinkButton>
            }
            primaryAction={
              <Button variant="primary/small" LeadingIcon={BeakerIcon}>
                Playground
              </Button>
            }
          />
        }
        tabs={
          <DetailTabs tabs={tabs} activeTab={tab} onTabChange={setTab} layoutId="agent-story" />
        }
        rail={
          <PropertyRail>
            <PropertyGroup title="Details">
              <DetailProperty label="Identifier">
                <CopyableText value="support-agent" className="font-mono text-xs" />
              </DetailProperty>
              <PropertyPair>
                <DetailProperty label="Type">Agent task</DetailProperty>
                <DetailProperty label="Created">Nov 18, 05:11</DetailProperty>
              </PropertyPair>
              <DetailProperty label="Agent type">
                <span className="font-mono text-xs">ai-sdk-chat</span>
              </DetailProperty>
              <DetailProperty label="Model">
                <ul className="flex flex-col gap-1">
                  {[
                    ["claude-haiku-4-5", "212 calls"],
                    ["gpt-4o-mini", "64 calls"],
                  ].map(([model, calls]) => (
                    <li key={model} className="flex items-baseline justify-between gap-2">
                      <span className="font-mono text-xs">{model}</span>
                      <span className="text-xs tabular-nums text-text-dimmed">{calls}</span>
                    </li>
                  ))}
                </ul>
              </DetailProperty>
            </PropertyGroup>
            <PropertyGroup title="Execution">
              <DetailProperty label="Queue">support-agent</DetailProperty>
              <PropertyPair>
                <DetailProperty label="Concurrency">2 of 300 running</DetailProperty>
                <DetailProperty label="Machine">small-1x</DetailProperty>
              </PropertyPair>
            </PropertyGroup>
            <PropertyGroup title="Source">
              <DetailProperty label="File path">
                <CopyableText value="src/trigger/ai.ts" className="font-mono text-xs" truncate />
              </DetailProperty>
            </PropertyGroup>
          </PropertyRail>
        }
      >
        {tab === "sessions" ? (
          <DetailTableTab
            tools={<PeriodChip value="7d" />}
            actions={
              <LinkButton variant="tertiary/small" to="#">
                Open in sessions list
              </LinkButton>
            }
            above={
              <div className="grid h-40 flex-none grid-cols-3 border-b border-grid-bright">
                <AgentBandPanel
                  label="Sessions"
                  total="187"
                  data={agentSessionsData}
                  config={sessionsChartConfig}
                />
                <AgentBandPanel
                  label="LLM spend"
                  total="$0.75"
                  data={agentSpendData}
                  config={{ spend: { label: "Spend", color: "var(--color-agents)" } }}
                  className="border-l border-grid-bright"
                />
                <AgentBandPanel
                  label="Tokens"
                  total="346.0k"
                  data={agentTokenData}
                  config={{ tokens: { label: "Tokens", color: "#14B8A6" } }}
                  className="border-l border-grid-bright"
                />
              </div>
            }
          >
            <StoryTable
              headers={["ID", "Status", "Type", "Created", "Duration"]}
              rows={[
                ["2ef19f04-6c02-4b8e", "Active", "chat.agent", "Today, 19:29", "42s"],
                ["667e82fd-24e4-4a1b", "Active", "chat.agent", "Today, 19:26", "3m 37s"],
                ["b8b2042e-71f0-49af", "Closed", "chat.agent", "Today, 19:24", "5m 3s"],
              ]}
            />
          </DetailTableTab>
        ) : tab === "runs" ? (
          <DetailTableTab tools={<PeriodChip value="7d" />}>
            <RunsTable />
          </DetailTableTab>
        ) : (
          <QueueSummary />
        )}
      </DetailPage>
    </>
  );
}

/** The task queue's slots and backlog, with the queue actions beside them. */
function QueueSummary() {
  const limit = 10;
  const running = 3;
  const queued = 12;
  return (
    <div className="flex flex-none flex-wrap items-center justify-between gap-x-8 gap-y-3 border-b border-grid-bright px-4 py-3.5">
      <div className="flex flex-wrap items-center gap-x-8 gap-y-3">
        <div className="flex flex-col gap-1.5">
          <span className="text-xs text-text-dimmed">
            <span className="tabular-nums text-text-bright">{running}</span> of {limit} slots
            running
          </span>
          <div className="flex gap-1" aria-label={`${running} of ${limit} concurrency slots used`}>
            {Array.from({ length: limit }).map((_, slot) => (
              <span
                key={slot}
                className={cn(
                  "h-5 w-3.5 rounded-sm",
                  slot < running ? "bg-pending" : "border border-grid-bright bg-background-deep"
                )}
              />
            ))}
          </div>
        </div>
        <div className="flex flex-col gap-1.5">
          <span className="text-xs text-text-dimmed">
            <span className="tabular-nums text-text-bright">{queued}</span> queued, oldest waiting
            2m 14s
          </span>
          <div className="flex h-5 items-end gap-0.5">
            {Array.from({ length: queued }).map((_, run) => (
              <span key={run} className="h-full w-1.5 rounded-[1px] bg-text-faint" />
            ))}
          </div>
        </div>
      </div>
      <div className="flex items-center gap-2">
        <Button variant="secondary/small">Override limit…</Button>
        <Button variant="secondary/small" LeadingIcon={PauseIcon}>
          Pause queue
        </Button>
      </div>
    </div>
  );
}

const queuedRuns = [
  ["run_5c2nq8x1vt", "2m 14s", "–"],
  ["run_9b4kd7w2zm", "2m 02s", "–"],
  ["run_3x8hr1m6qp", "1m 41s", "10s"],
  ["run_7q1jt5c9wn", "1m 33s", "–"],
  ["run_2m6vk8b4xs", "1m 08s", "–"],
  ["run_8d3wz2n7rc", "54s", "–"],
  ["run_4t9pb6h1ky", "41s", "–"],
  ["run_6n2xq4r8jm", "30s", "–"],
  ["run_1k7cm3w9vd", "22s", "–"],
  ["run_9r5ty2p6bq", "15s", "–"],
  ["run_3h8ks1x4nz", "9s", "–"],
  ["run_7w2bn6d3tc", "3s", "–"],
];

// ---------- bulk action ----------

type BulkTab = "runs" | "failed";

const bulkTitle = "Replay failed send-invoice-reminder runs after the Nov 17 SMTP outage";

function BulkHeader() {
  return (
    <DetailHeader
      icon={ListCheckedIcon}
      iconClassName="text-bulkActions"
      title={bulkTitle}
      status={<BulkActionStatusCombo status="PENDING" />}
      meta={[
        <BulkActionTypeCombo key="type" type="REPLAY" iconClassName="size-3.5" />,
        "1,284 runs",
        "Started 6m ago by Dev Patel",
      ]}
      friendlyId="bulk_6tq2w8zr4n"
      secondaryActions={
        <LinkButton
          variant="secondary/small"
          LeadingIcon={RunsIcon}
          leadingIconClassName="text-runs"
          to="#"
        >
          View runs
        </LinkButton>
      }
      primaryAction={
        <Button
          variant="danger/small"
          LeadingIcon={NoSymbolIcon}
          disabled
          tooltip="You don't have permission to abort bulk actions"
        >
          Abort…
        </Button>
      }
    />
  );
}

function BulkActionPage() {
  const [tab, setTab] = useState<BulkTab>("runs");
  const tabs: DetailTab<BulkTab>[] = [
    { id: "runs", label: "Runs", count: "890" },
    { id: "failed", label: "Failed", count: "22" },
  ];

  return (
    <>
      <Nav back="Bulk actions" title={bulkTitle} />
      <DetailPage
        id="story-bulk"
        header={<BulkHeader />}
        tabs={<DetailTabs tabs={tabs} activeTab={tab} onTabChange={setTab} layoutId="bulk" />}
        rail={
          <PropertyRail>
            <PropertyGroup title="Progress">
              <ProgressMeter
                title="Processed"
                total={1284}
                segments={[
                  { count: 890, label: "replayed", className: "bg-success" },
                  { count: 22, label: "failed", className: "bg-error" },
                ]}
              />
            </PropertyGroup>
            <PropertyGroup title="Details">
              <DetailProperty label="ID">
                <CopyableText value="bulk_6tq2w8zr4n" className="font-mono text-xs" />
              </DetailProperty>
              <PropertyPair>
                <DetailProperty label="Status">
                  <BulkActionStatusCombo status="PENDING" />
                </DetailProperty>
                <DetailProperty label="Type">
                  <BulkActionTypeCombo type="REPLAY" />
                </DetailProperty>
                <DetailProperty label="Created">Nov 17, 16:36</DetailProperty>
                <DetailProperty label="Completed">–</DetailProperty>
              </PropertyPair>
              <DetailProperty label="Created by">Dev Patel</DetailProperty>
            </PropertyGroup>
            <PropertyGroup title="Selection">
              <DetailProperty label="Runs">1,284 matching</DetailProperty>
              <BulkActionFilterList
                runsListPath="#"
                filters={{
                  statuses: ["COMPLETED_WITH_ERRORS", "CRASHED"],
                  tasks: ["send-invoice-reminder"],
                  tags: ["billing", "smtp"],
                  from: new Date("2026-11-17T09:00:00Z").getTime(),
                  to: new Date("2026-11-17T13:00:00Z").getTime(),
                }}
              />
            </PropertyGroup>
          </PropertyRail>
        }
      >
        {tab === "runs" ? (
          <DetailTableTab
            actions={
              <LinkButton
                variant="tertiary/small"
                to="#"
                LeadingIcon={RunsIcon}
                leadingIconClassName="text-runs"
              >
                Open in runs list
              </LinkButton>
            }
          >
            <RunsTable />
          </DetailTableTab>
        ) : (
          <DetailTableTab
            actions={
              <>
                <LinkButton
                  variant="tertiary/small"
                  to="#"
                  LeadingIcon={RunsIcon}
                  leadingIconClassName="text-runs"
                >
                  Open in runs list
                </LinkButton>
                <Button
                  variant="secondary/small"
                  LeadingIcon={ArrowPathIcon}
                  leadingIconClassName="text-indigo-500"
                >
                  Replay these
                </Button>
              </>
            }
          >
            <StoryTable
              headers={["Run", "Task", "Reason"]}
              rows={[
                [
                  "run_4mq8d1xk2r",
                  "send-invoice-reminder",
                  "Task send-invoice-reminder has no current deployment",
                ],
                ["run_8nb2x7k1qw", "send-invoice-reminder", "Run payload is larger than 10 MB"],
                [
                  "run_2zr9m4c8tv",
                  "send-invoice-reminder",
                  "Task send-invoice-reminder has no current deployment",
                ],
                ["run_6kw3p1n9xd", "send-invoice-reminder", "Queue is paused"],
              ]}
            />
          </DetailTableTab>
        )}
      </DetailPage>
    </>
  );
}

// ---------- webhook endpoint ----------

type WebhookTab = "deliveries" | "subscribers" | "waiters" | "settings";

const ingestUrl = "https://api.trigger.dev/webhooks/v1/ingest/whi_q8m2k7x4p9t3";

function WebhookPage({ initialTab = "deliveries" }: { initialTab?: WebhookTab }) {
  const [tab, setTab] = useState<WebhookTab>(initialTab);
  const tabs: DetailTab<WebhookTab>[] = [
    { id: "deliveries", label: "Deliveries", count: "48,210" },
    { id: "subscribers", label: "Subscribers", count: "3" },
    { id: "waiters", label: "Waiters", count: "2" },
    { id: "settings", label: "Settings" },
  ];

  return (
    <>
      <Nav back="Endpoints" title="stripe-billing" docs="Webhooks docs" />
      <DetailPage
        id="story-webhook"
        header={
          <DetailHeader
            icon={WebhookIcon}
            iconClassName="text-webhooks"
            title="stripe-billing"
            mono
            status={<EndpointStatusBadge status="ACTIVE" />}
            meta={["Source Stripe", "Default tenant", "Last delivery 14s ago"]}
            friendlyId="wh_3n8x2k5v7q"
            secondaryActions={
              <Button variant="secondary/small" LeadingIcon={ClipboardDocumentIcon}>
                Copy setup prompt
              </Button>
            }
            primaryAction={
              <Button variant="primary/small" LeadingIcon={PaperAirplaneIcon}>
                Send test event
              </Button>
            }
          />
        }
        tabs={
          <DetailTabs
            tabs={tabs}
            activeTab={tab}
            onTabChange={setTab}
            layoutId={`webhook-${initialTab}`}
          />
        }
        rail={
          <PropertyRail>
            <PropertyGroup title="Details">
              <PropertyPair>
                <DetailProperty label="ID">
                  <CopyableText value="wh_3n8x2k5v7q" className="font-mono text-xs" truncate />
                </DetailProperty>
                <DetailProperty label="Status">
                  <EndpointStatusBadge status="ACTIVE" />
                </DetailProperty>
                <DetailProperty label="Source">Stripe</DetailProperty>
                <DetailProperty label="Tenant">None</DetailProperty>
                <DetailProperty label="Created">Sep 14, 11:02</DetailProperty>
                <DetailProperty label="External ref">None</DetailProperty>
              </PropertyPair>
            </PropertyGroup>
            <PropertyGroup title="Connect">
              <DetailProperty label="Webhook URL">
                <CopyableText value={ingestUrl} className="min-w-0 font-mono text-xs" truncate />
              </DetailProperty>
              <PropertyPair>
                <DetailProperty label="Signing secret">
                  <EndpointStatusBadge status="ACTIVE" />
                </DetailProperty>
                <DetailProperty label="Verify token">Not set</DetailProperty>
              </PropertyPair>
            </PropertyGroup>
            <PropertyGroup title="Signature">
              <PropertyPair>
                <DetailProperty label="Scheme">HMAC SHA-256</DetailProperty>
                <DetailProperty label="Header">Stripe-Signature</DetailProperty>
              </PropertyPair>
            </PropertyGroup>
          </PropertyRail>
        }
      >
        {tab === "deliveries" ? (
          <DetailTableTab
            tools={
              <>
                <PeriodChip value="24h" />
                <FilterChip label="Status" value="Any" />
              </>
            }
          >
            <StoryTable
              headers={["Delivery", "Status", "External delivery ID", "Created", "Error"]}
              rows={[
                ["whd_8k2m4x9q1r", "Processing", "evt_3QyH8sLk2Ab", "Nov 17, 16:42:09", "–"],
                ["whd_5n7b2v8c3t", "Succeeded", "evt_3QyH7pWm9Cd", "Nov 17, 16:41:55", "–"],
                [
                  "whd_2p9w6z1k4m",
                  "Failed",
                  "evt_3QyH6rTn4Ef",
                  "Nov 17, 16:40:31",
                  <span key="err" className="text-error">
                    Signature did not match
                  </span>,
                ],
                ["whd_7q3j8d5h2x", "Filtered", "evt_3QyH5kBv1Gh", "Nov 17, 16:39:47", "–"],
                ["whd_4r6t1y9u3i", "Succeeded", "evt_3QyH4jCx8Ij", "Nov 17, 16:38:02", "–"],
                ["whd_1m8c3v6b2n", "Succeeded", "evt_3QyH3aDz7Kl", "Nov 17, 16:37:40", "–"],
                ["whd_9x4z7q2w5e", "Succeeded", "evt_3QyH2bEy6Mn", "Nov 17, 16:36:18", "–"],
              ]}
            />
          </DetailTableTab>
        ) : tab === "subscribers" ? (
          <DetailTableTab>
            <StoryTable
              headers={["Task", "Filter", "Version", "Deliveries (24h)", "Last delivery"]}
              rows={[
                ["handle-invoice-paid", "invoice.paid", "20261117.3", "1,204", "14s ago"],
                [
                  "handle-subscription-change",
                  "customer.subscription.*",
                  "20261117.3",
                  "318",
                  "2m ago",
                ],
                ["stripe-webhook-router", "Every delivery", "20261117.3", "1,961", "14s ago"],
              ]}
              alignRight={[3]}
            />
          </DetailTableTab>
        ) : tab === "waiters" ? (
          <DetailTableTab>
            <StoryTable
              headers={["Run", "Waiting for", "Since", "Times out"]}
              rows={[
                ["run_6p3kx9m2wq", "invoice.paid where id = in_1QyH8s", "Nov 17, 15:02", "In 3h"],
                ["run_2v8nb4t7zc", "charge.refunded", "Nov 17, 16:20", "In 6d"],
              ]}
            />
          </DetailTableTab>
        ) : (
          <DetailMain className="gap-7">
            <WebhookSettings />
          </DetailMain>
        )}
      </DetailPage>
    </>
  );
}

function WebhookSettings() {
  return (
    <div className="flex flex-col gap-7">
      <SettingGroup title="Connect">
        <SettingRow
          title="Webhook URL"
          description="Paste this into the provider"
          value={<code className="truncate font-mono text-xs">{ingestUrl}</code>}
          control={
            <Button variant="secondary/small" LeadingIcon={ClipboardDocumentIcon}>
              Copy
            </Button>
          }
        />
        <SettingRow
          title="Signing secret"
          description="Last rotated Oct 30"
          value={<EndpointStatusBadge status="ACTIVE" />}
          control={
            <Button variant="secondary/small" LeadingIcon={KeyIcon}>
              Rotate…
            </Button>
          }
        />
        <SettingRow
          title="Verify token"
          description="Only some providers need one"
          value="Not set"
          control={<Button variant="secondary/small">Set token…</Button>}
        />
      </SettingGroup>
      <SettingGroup title="Routing">
        <SettingRow
          title="Default filter"
          description="Applies when a subscriber has none"
          value="Every delivery"
          control={<Button variant="secondary/small">Edit…</Button>}
        />
      </SettingGroup>
      <DangerZone>
        <SettingRow
          title="Disable endpoint"
          description="Stops accepting deliveries until enabled"
          control={
            <Button
              variant="danger/small"
              disabled
              tooltip="Unavailable while 2 deliveries are replaying"
            >
              Disable…
            </Button>
          }
        />
        <SettingRow
          title="Delete endpoint"
          description="Removes it and its delivery history"
          control={<Button variant="danger/small">Delete…</Button>}
        />
      </DangerZone>
    </div>
  );
}

// ---------- shared story bits ----------

const stateTabs: DetailTab[] = [
  { id: "deliveries", label: "Deliveries", count: "0" },
  { id: "subscribers", label: "Subscribers", count: "0" },
  { id: "waiters", label: "Waiters", count: "0" },
  { id: "settings", label: "Settings" },
];

function TabsDemo() {
  const [tab, setTab] = useState("logs");
  return (
    <div className="flex flex-col gap-3">
      <div className="overflow-hidden rounded-sm border border-grid-bright">
        <DetailTabs
          tabs={[
            { id: "overview", label: "Overview" },
            { id: "tasks", label: "Tasks", count: "14" },
            { id: "runs", label: "Runs", count: "3,117" },
            { id: "logs", label: "Build logs" },
            { id: "activity", label: "Activity" },
          ]}
          activeTab={tab}
          onTabChange={setTab}
          layoutId="tabs-demo"
          tools={<PeriodChip value="24h" />}
        />
      </div>
      <div className="w-[300px] overflow-hidden rounded-sm border border-grid-bright">
        <DetailTabs
          tabs={[
            { id: "deliveries", label: "Deliveries", count: "48,210" },
            { id: "subscribers", label: "Subscribers", count: "3" },
            { id: "waiters", label: "Waiters", count: "2" },
            { id: "settings", label: "Settings" },
          ]}
          activeTab="deliveries"
          onTabChange={() => {}}
          layoutId="tabs-demo-narrow"
        />
      </div>
    </div>
  );
}

function PeriodChip({ value }: { value: string }) {
  return (
    <span className="flex h-6 items-center gap-1.5 rounded bg-background-hover px-2 text-xs text-text-dimmed">
      Period <span className="font-medium text-text-bright">{value}</span>
    </span>
  );
}

function FilterChip({ label, value }: { label: string; value: string }) {
  return (
    <span className="flex h-6 items-center gap-1.5 rounded bg-background-hover px-2 text-xs text-text-dimmed">
      {label} <span className="font-medium text-text-bright">{value}</span>
    </span>
  );
}

function SearchChip({ placeholder }: { placeholder: string }) {
  return (
    <span className="flex h-6 w-48 items-center rounded border border-grid-bright px-2 text-xs text-text-faint">
      {placeholder}
    </span>
  );
}

/** A house table, edge to edge: no wrapper padding, sticky header, first column mono. */
function StoryTable({
  headers,
  rows,
  alignRight = [],
}: {
  headers: string[];
  rows: ReactNode[][];
  alignRight?: number[];
}) {
  return (
    <Table variant="dimmed" showTopBorder={false} stickyHeader>
      <TableHeader>
        <TableRow>
          {headers.map((header, index) => (
            <TableHeaderCell key={header} alignment={alignRight.includes(index) ? "right" : "left"}>
              {header}
            </TableHeaderCell>
          ))}
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row, index) => (
          <TableRow key={index}>
            {row.map((cell, cellIndex) => (
              <TableCell
                key={cellIndex}
                alignment={alignRight.includes(cellIndex) ? "right" : "left"}
                className={cellIndex === 0 ? "font-mono text-xs text-text-bright" : undefined}
              >
                {cell}
              </TableCell>
            ))}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function RunsTable() {
  const rows = [
    ["run_9x2kq8m3vt", "EXECUTING", "Nov 17, 16:41:02", "12.4s"],
    ["run_7hb3p2w9zn", "COMPLETED_SUCCESSFULLY", "Nov 17, 16:40:51", "3.1s"],
    ["run_4mq8d1xk2r", "COMPLETED_WITH_ERRORS", "Nov 17, 16:39:18", "30.0s"],
    ["run_2tz6n4c8yb", "COMPLETED_SUCCESSFULLY", "Nov 17, 16:38:44", "2.8s"],
    ["run_8vk1r5j7ws", "COMPLETED_SUCCESSFULLY", "Nov 17, 16:37:09", "3.4s"],
    ["run_5pc2n9h4tx", "COMPLETED_SUCCESSFULLY", "Nov 17, 16:36:30", "2.9s"],
    ["run_3wq7m1z8kd", "CRASHED", "Nov 17, 16:35:12", "5m 0s"],
    ["run_6jr4b2x9vn", "COMPLETED_SUCCESSFULLY", "Nov 17, 16:34:47", "3.0s"],
    ["run_1yt8k3c5mz", "COMPLETED_SUCCESSFULLY", "Nov 17, 16:33:59", "3.3s"],
    ["run_7dn5w2q6rb", "COMPLETED_SUCCESSFULLY", "Nov 17, 16:33:21", "2.7s"],
    ["run_4ks9p1v3hx", "COMPLETED_SUCCESSFULLY", "Nov 17, 16:32:40", "3.6s"],
    ["run_8bm2t6n4qc", "COMPLETED_SUCCESSFULLY", "Nov 17, 16:31:05", "3.2s"],
  ] as const;
  return (
    <StoryTable
      headers={["Run ID", "Task", "Status", "Started", "Duration", "Version"]}
      rows={rows.map(([id, status, started, duration]) => [
        id,
        "send-invoice-reminder",
        <TaskRunStatusCombo key="status" status={status} />,
        started,
        duration,
        "20261117.3",
      ])}
      alignRight={[4]}
    />
  );
}

const runsChartConfig = {
  completed: { label: "Completed", color: "var(--color-success)" },
  failed: { label: "Failed", color: "var(--color-error)" },
} satisfies ChartConfig;

const hourLabel = (index: number) => `${String((14 + index) % 24).padStart(2, "0")}:00`;
const deployChartData = Array.from({ length: 24 }, (_, i) => ({
  bucket: hourLabel(i),
  completed: [22, 30, 28, 41, 52, 60, 58, 49, 44, 63, 70, 66, 59, 72, 80, 68, 61, 57, 74, 79, 70][
    i % 21
  ],
  failed: [1, 0, 2, 0, 3, 0, 1, 0, 0, 2, 0, 1][i % 12],
}));

function StatusChart({
  title,
  data,
  config,
}: {
  title: string;
  data: Record<string, string | number>[];
  config: ChartConfig;
}) {
  return (
    <DetailSection>
      <DetailSectionHeading
        title={title}
        actions={
          <span className="flex items-center gap-3 text-[0.6875rem] font-medium text-text-dimmed">
            {Object.entries(config).map(([key, item]) => (
              <span key={key} className="inline-flex items-center gap-1.5">
                <i
                  className="inline-block size-2 rounded-[2px]"
                  style={{ background: item.color }}
                />
                {item.label}
              </span>
            ))}
          </span>
        }
      />
      <div className="h-36">
        <Chart.Root config={config} data={data} dataKey="bucket" fillContainer>
          <Chart.Bar stackId="a" />
        </Chart.Root>
      </div>
    </DetailSection>
  );
}
