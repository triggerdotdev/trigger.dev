import {
  ArrowPathIcon,
  BeakerIcon,
  BellIcon,
  BookOpenIcon,
  ClipboardDocumentIcon,
  KeyIcon,
  NoSymbolIcon,
  PaperAirplaneIcon,
} from "@heroicons/react/20/solid";
import { type ReactNode, useState } from "react";
import { DeploymentsIcon } from "~/assets/icons/DeploymentsIcon";
import { ListCheckedIcon } from "~/assets/icons/ListCheckedIcon";
import { RunsIcon } from "~/assets/icons/RunsIcon";
import { TasksIcon } from "~/assets/icons/TasksIcon";
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
  SkeletonBone,
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
import { DeploymentStatus } from "~/components/runs/v3/DeploymentStatus";
import { TaskRunStatusCombo } from "~/components/runs/v3/TaskRunStatus";
import { EndpointStatusBadge } from "~/components/webhookEndpoints/v1/EndpointStatus";
import { StoryPage, StorySection, StorySubSection } from "../storybook/StoryKit";

/* The detail page template (components/primitives/detail) with static data. Each entity has its
   own tabs: no page assumes an Overview or an Activity tab. Tables run edge to edge. */
export default function Story() {
  return (
    <StoryPage
      title="Detail pages"
      componentNames={["DetailPage.tsx", "DetailSections.tsx"]}
      description="One template for detail pages: a header that owns identity and actions, the entity's own tabs, a main column for the selected tab, and a property rail. Tables in the main column run edge to edge. The bulk action page is the first page built on it."
    >
      <StorySection
        title="Bulk action"
        description="In progress. Tabs: Runs and Failed. Progress sits at the top of the rail, above Details."
      >
        <Frame>
          <BulkActionPage />
        </Frame>
      </StorySection>
      <StorySection
        title="Narrow width"
        description="Below 900px of page width the rail closes and Details opens it as a sheet. Secondary actions fold into the more menu below 1100px."
      >
        <Frame width="w-[768px]" height="h-[560px]">
          <BulkActionPage />
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

      <StorySection
        title="DetailMain and DetailSection"
        componentName="DetailSections.tsx"
        description="A tab that isn't a table: sections in the main column, each with a heading and its own actions."
      >
        <div className="overflow-hidden rounded-sm border border-grid-bright bg-background-dimmed">
          <DetailMain>
            <StatusChart title="Runs" data={runsChartData} config={runsChartConfig} />
          </DetailMain>
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
          <StorySubSection title="A value on its way">
            <div className="flex w-64 flex-col gap-2">
              <SkeletonBone className="w-40" />
              <SkeletonBone className="w-24" />
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

// ---------- headers and rail ----------

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

const ingestUrl = "https://api.trigger.dev/webhooks/v1/ingest/whi_q8m2k7x4p9t3";

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
const runsChartData = Array.from({ length: 24 }, (_, i) => ({
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
