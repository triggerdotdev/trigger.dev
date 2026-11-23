import {
  ArrowUturnLeftIcon,
  ClockIcon,
  ExclamationTriangleIcon,
  NoSymbolIcon,
} from "@heroicons/react/20/solid";
import { InfoPanel } from "~/components/primitives/InfoPanel";
import { CliVersionWarningBadge } from "~/components/deployments/CliVersionWarning";
import { TruncatedText } from "~/components/primitives/TruncatedText";
import { Paragraph } from "~/components/primitives/Paragraph";
import { ClientOnly } from "remix-utils/client-only";
import { type ShouldRevalidateFunction, useLocation } from "@remix-run/react";
import { type LoaderFunctionArgs } from "@remix-run/server-runtime";
import { formatDurationMilliseconds } from "@trigger.dev/core/v3";
import type { WorkerDeploymentStatus } from "@trigger.dev/database";
import { GitBranchIcon, LayoutDashboardIcon, ServerIcon, TerminalSquareIcon } from "lucide-react";
import { lazy, type ReactNode, Suspense } from "react";
import {
  TypedAwait,
  typeddefer,
  type UseDataFunctionReturn,
  useTypedLoaderData,
} from "remix-typedjson";
import { DeploymentsIcon } from "~/assets/icons/DeploymentsIcon";
import { PromoteIcon } from "~/assets/icons/PromoteIcon";
import { RunsIcon } from "~/assets/icons/RunsIcon";
import { TasksIcon } from "~/assets/icons/TasksIcon";
import { AdminDebugTooltip } from "~/components/admin/debugTooltip";
import { CodeBlock } from "~/components/code/CodeBlock";
import { InlineCode } from "~/components/code/InlineCode";
import { deploymentAgentPageContext } from "~/components/dashboard-agent/suggested-prompts";
import { BuildLogsViewer } from "~/components/deployments/BuildLogsViewer";
import { DeploymentResources } from "~/components/deployments/DeploymentResources";
import {
  DEPLOYMENT_TABS,
  type DeploymentTab as DeployTab,
  deploymentTabs,
} from "~/components/deployments/deploymentTabs";
import {
  ActivityBarChartBlankState,
  ACTIVITY_CHART_HEIGHT,
} from "~/components/metrics/ActivityBarChartBlankState";
import { EnvironmentCombo } from "~/components/environments/EnvironmentLabel";
import { GitMetadata } from "~/components/GitMetadata";
import { VercelLink } from "~/components/integrations/VercelLink";
import { MainCenteredContainer, PageBody, PageContainer } from "~/components/layout/AppLayout";
import { DirectionSchema, ListPagination } from "~/components/ListPagination";
import { Badge } from "~/components/primitives/Badge";
import { Button, LinkButton } from "~/components/primitives/Buttons";
import { ChartBlankState } from "~/components/primitives/charts/ChartBlankState";
import { CopyableText } from "~/components/primitives/CopyableText";
import { DateTime, DateTimeAccurate, RelativeDateTime } from "~/components/primitives/DateTime";
import {
  DetailHeader,
  DetailPageTitle,
  DetailMain,
  DetailPage,
  DetailProperty,
  DetailTabs,
  PropertyGroup,
  PropertyPair,
  PropertyRail,
  useDetailTab,
} from "~/components/primitives/detail/DetailPage";
import { DeferredContent } from "~/components/primitives/detail/DeferredContent";
import {
  type ActivityStep,
  ActivityTimeline,
  ChartSkeleton,
  DetailSection,
  DetailSectionHeading,
  DetailTabError,
  DetailTableTab,
  DetailTabLoading,
  SkeletonBone,
} from "~/components/primitives/detail/DetailSections";
import { Dialog, DialogTrigger } from "~/components/primitives/Dialog";
import { NavBar, PageAccessories } from "~/components/primitives/PageHeader";
import { PopoverMenuItem } from "~/components/primitives/Popover";
import * as Property from "~/components/primitives/PropertyTable";
import {
  Table,
  TableBlankRow,
  TableBody,
  TableCell,
  TableCellMenu,
  TableHeader,
  TableHeaderCell,
  TableRow,
} from "~/components/primitives/Table";
import { TextLink } from "~/components/primitives/TextLink";
import { RuntimeIcon } from "~/components/RuntimeIcon";
import { DeploymentStatus, deploymentDisplayStatus } from "~/components/runs/v3/DeploymentStatus";
import { TaskRunsTable } from "~/components/runs/v3/TaskRunsTable";
import {
  TaskTriggerSourceIcon,
  taskTriggerSourceDescription,
} from "~/components/runs/v3/TaskTriggerSource";
import { Spinner } from "~/components/primitives/Spinner";
import { SimpleTooltip } from "~/components/primitives/Tooltip";
import { ACTIVITY_CELL_WIDTH, TaskActivityGraph } from "~/components/tasks/TaskActivityGraph";
import { $replica } from "~/db.server";
import { env } from "~/env.server";
import { useAutoRevalidate } from "~/hooks/useAutoRevalidate";
import { useDeploymentLogs } from "~/hooks/useDeploymentLogs";
import { useEnvironment } from "~/hooks/useEnvironment";
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
import {
  DeploymentOverviewPresenter,
  type DeploymentPrompts,
  type VersionTaskActivity,
} from "~/presenters/v3/DeploymentOverviewPresenter.server";
import { DeploymentPresenter } from "~/presenters/v3/DeploymentPresenter.server";
import { NextRunListPresenter } from "~/presenters/v3/NextRunListPresenter.server";
import { getRunColumnsForSelect } from "~/presenters/v3/runColumnsFromRequest.server";
import { clickhouseFactory } from "~/services/clickhouse/clickhouseFactoryInstance.server";
import { rbac } from "~/services/rbac.server";
import { checkPermissions } from "~/services/routeBuilders/permissions.server";
import { requireUserId } from "~/services/session.server";
import { onlyDetailTabChanged } from "~/utils/detailTabRevalidation";
import type { Handle } from "~/utils/handle";
import { throwNotFound } from "~/utils/httpErrors";
import { throwPermissionDenied } from "~/utils/permissionDenied";
import { formatNumber } from "~/utils/numberFormatter";
import { pageMeta } from "~/utils/pageTitle";
import {
  v3AgentTaskPath,
  v3DeploymentParams,
  v3DeploymentPath,
  v3DeploymentsPath,
  v3RunsPath,
  v3ScheduledTaskPath,
  v3StandardTaskPath,
  v3WebhookTaskPath,
} from "~/utils/pathBuilder";
import { capitalizeWord } from "~/utils/string";
import { deploymentRunsWindow } from "~/v3/utils/deploymentRunsWindow";
import { compareDeploymentVersions } from "~/v3/utils/deploymentVersions";
import {
  CancelDeploymentDialog,
  PromoteDeploymentDialog,
  RollbackDeploymentDialog,
  UserTag,
} from "~/components/deployments/DeploymentDialogs";

// The runs chart brings recharts; it draws from deferred data in the browser, so its code loads
// with that data rather than before the page can respond to clicks.
const DeploymentRunsChart = lazy(() =>
  import("~/components/deployments/DeploymentRunsChart").then((module) => ({
    default: module.DeploymentRunsChart,
  }))
);

export const handle: Handle = {
  agentPageContext: (data) => deploymentAgentPageContext(data),
};

export const meta = pageMeta<typeof loader>(({ data, params }) => [
  data?.deployment?.version ?? params.deploymentParam ?? "Deployment",
  "Deployments",
]);

const TAB_LABELS: Record<DeployTab, string> = {
  overview: "Overview",
  tasks: "Tasks",
  runs: "Runs",
  logs: "Build logs",
  activity: "Activity",
};

const FINAL_STATUSES: WorkerDeploymentStatus[] = ["DEPLOYED", "FAILED", "CANCELED", "TIMED_OUT"];

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const userId = await requireUserId(request);
  const { organizationSlug, projectParam, envParam, deploymentParam } =
    v3DeploymentParams.parse(params);
  const url = new URL(request.url);

  try {
    const result = await new DeploymentPresenter().call({
      userId,
      organizationSlug,
      projectSlug: projectParam,
      environmentSlug: envParam,
      deploymentShortCode: deploymentParam,
    });

    if (!result) {
      throwNotFound("Deployment not found");
    }

    const { deployment } = result;
    const organizationId = deployment.organizationId;
    const environmentId = deployment.environment.id;
    const isCurrent = deployment.label === "current";

    // Read access is decided in the project's scope. The write flag is read in the
    // organization's scope, which is how the promote, rollback and cancel actions authenticate.
    const [readAuth, writeAuth, currentPromotion, nextDeployment] = await Promise.all([
      rbac.authenticateSession(request, {
        userId,
        organizationId,
        projectId: deployment.projectId,
      }),
      rbac.authenticateSession(request, { userId, organizationId }),
      $replica.workerDeploymentPromotion.findFirst({
        where: { environmentId, label: "current" },
        select: { deployment: { select: { version: true } } },
      }),
      // The deploy after this one bounds where this version's runs are. Uses
      // @@index([environmentId, createdAt]).
      deployment.tasks && !isCurrent
        ? $replica.workerDeployment.findFirst({
            where: {
              environmentId,
              createdAt: { gt: deployment.createdAt },
              deployedAt: { not: null },
            },
            orderBy: { createdAt: "asc" },
            select: { deployedAt: true },
          })
        : null,
    ]);
    const runsWindow = deploymentRunsWindow({
      startedAt: deployment.deployedAt ?? deployment.createdAt,
      nextDeployedAt: nextDeployment?.deployedAt,
      isCurrent,
    });
    if (!readAuth.ok || !readAuth.ability.can("read", { type: "deployments" })) {
      throwPermissionDenied();
    }
    // Display flag only: the promote, rollback and cancel actions check write:deployments.
    const canWriteDeployments = writeAuth.ok
      ? checkPermissions(writeAuth.ability, {
          canWriteDeployments: { action: "write", resource: { type: "deployments" } },
        }).canWriteDeployments
      : true;

    // Every tab's data loads up front so switching tabs needs no request (see shouldRevalidate).
    // The Postgres parts (counts, resources, tasks) are awaited; the ClickHouse chart and task
    // activity, the prompt versions and the runs list are deferred, so the header, tabs and rail
    // render right away.
    const overview = deployment.tasks
      ? await new DeploymentOverviewPresenter(
          $replica,
          await clickhouseFactory.getClickhouseForOrganization(organizationId, "standard")
        ).call({
          organizationId,
          projectId: deployment.projectId,
          environmentId,
          deploymentId: deployment.id,
        })
      : null;

    const runList = deployment.tasks
      ? clickhouseFactory
          .getClickhouseForOrganization(organizationId, "runsList")
          .then((clickhouse) =>
            new NextRunListPresenter($replica, clickhouse).call(organizationId, environmentId, {
              userId,
              projectId: deployment.projectId,
              versions: [deployment.version],
              from: runsWindow.from,
              to: runsWindow.to,
              cursor: url.searchParams.get("cursor") ?? undefined,
              direction: DirectionSchema.catch("forward").parse(
                url.searchParams.get("direction") ?? undefined
              ),
              columns: getRunColumnsForSelect(request),
            })
          )
      : Promise.resolve(null);

    return typeddefer({
      deployment,
      eventStream: result.eventStream,
      overview: overview?.overview ?? null,
      chart: overview?.chart ?? Promise.resolve(null),
      taskActivity:
        overview?.taskActivity ?? Promise.resolve<VersionTaskActivity>({ hourly: {}, running: {} }),
      prompts: overview?.prompts ?? Promise.resolve<DeploymentPrompts>([]),
      runList,
      runsWindow,
      canWriteDeployments,
      currentVersion: currentPromotion?.deployment.version,
      autoReloadPollIntervalMs: env.DEPLOYMENTS_AUTORELOAD_POLL_INTERVAL_MS,
    });
  } catch (error) {
    if (error instanceof Response) throw error;
    console.error(error);
    throw new Response(undefined, {
      status: 400,
      statusText: "Something went wrong, if this problem persists please contact support.",
    });
  }
};

/** Every tab's data is already loaded: switching tabs doesn't run the loader again. */
export const shouldRevalidate: ShouldRevalidateFunction = (args) =>
  onlyDetailTabChanged(args) ? false : args.defaultShouldRevalidate;

type LoaderData = UseDataFunctionReturn<typeof loader>;
type Deployment = LoaderData["deployment"];
type Overview = NonNullable<LoaderData["overview"]>;
type TaskActivity = LoaderData["taskActivity"];
type ChartData = LoaderData["chart"];

/** The runs table's default columns, for the Runs tab skeleton. */
const RUN_SKELETON_COLUMNS = [
  { label: "ID" },
  { label: "Task" },
  { label: "Status" },
  { label: "Version" },
  { label: "Started" },
  { label: "Duration" },
  { label: "Machine" },
];

export default function Page() {
  const {
    deployment,
    eventStream,
    overview,
    chart,
    taskActivity,
    prompts,
    runList,
    runsWindow,
    canWriteDeployments,
    currentVersion,
    autoReloadPollIntervalMs,
  } = useTypedLoaderData<typeof loader>();
  const organization = useOrganization();
  const project = useProject();
  const environment = useEnvironment();
  const location = useLocation();
  const page = new URLSearchParams(location.search).get("page");
  const hasWorker = !!deployment.tasks;
  const hasLogs = !!eventStream;
  const tabIds = deploymentTabs({ hasWorker, hasLogs });
  const [tab, setTab, isTabPending] = useDetailTab<DeployTab>(tabIds);
  const cursor = new URLSearchParams(location.search).get("cursor") ?? "";
  const isFinal = FINAL_STATUSES.includes(deployment.status);

  // A deploy in progress moves through its statuses; keep the page current until it settles.
  useAutoRevalidate({ interval: autoReloadPollIntervalMs, onFocus: true, disabled: isFinal });

  const { logs, isStreaming, streamError } = useDeploymentLogs({
    eventStream: tab === "logs" ? eventStream : undefined,
    status: deployment.status,
  });

  const runsPath = v3RunsPath(organization, project, environment, {
    versions: [deployment.version],
    from: runsWindow.from,
  });
  // The Runs tab lists a bounded range; the links out are open-ended, so every run stays reachable.
  const runsRange = runsWindow.to ? (
    <span className="text-xs text-text-dimmed">
      Runs created up to <DateTime date={new Date(runsWindow.to)} />. Later runs are in the runs
      list.
    </span>
  ) : undefined;
  const showLogs = () => setTab(hasLogs ? "logs" : "activity");

  return (
    <PageContainer>
      <NavBar>
        <DetailPageTitle
          title={deployment.version}
          backButton={{
            to: `${v3DeploymentsPath(organization, project, environment)}${
              page ? `?page=${page}` : ""
            }`,
            text: "Deployments",
          }}
        />
        <PageAccessories>
          <AdminDebug deployment={deployment} />
        </PageAccessories>
      </NavBar>
      <PageBody scrollable={false}>
        <DetailPage
          id="deployment"
          header={
            <DeploymentHeader
              deployment={deployment}
              currentVersion={currentVersion}
              canWriteDeployments={canWriteDeployments}
              runsPath={runsPath}
            />
          }
          tabs={
            <DetailTabs
              tabs={DEPLOYMENT_TABS.filter((id) => tabIds.includes(id)).map((id) => ({
                id,
                label: TAB_LABELS[id],
                count: id === "tasks" ? formatNumber(deployment.tasks?.length ?? 0) : undefined,
              }))}
              activeTab={tab}
              onTabChange={(next) => setTab(next, { cursor: undefined, direction: undefined })}
              layoutId="deployment-tab"
            />
          }
          rail={<DeploymentRail deployment={deployment} />}
        >
          {tab === "logs" ? (
            <BuildLogsViewer
              logs={logs}
              isStreaming={isStreaming}
              streamError={streamError}
              downloadName={`${deployment.version}-build.log`}
            />
          ) : tab === "activity" ? (
            <DeploymentActivity
              deployment={deployment}
              onViewLogs={hasLogs ? () => setTab("logs") : undefined}
            />
          ) : !hasWorker ? (
            <NoWorker deployment={deployment} tab={tab} onViewLogs={showLogs} hasLogs={hasLogs} />
          ) : tab === "overview" ? (
            overview ? (
              <DeploymentOverview
                deployment={deployment}
                overview={overview}
                chart={chart}
                prompts={prompts}
                runsFrom={runsWindow.from}
              />
            ) : (
              <DeploymentOverviewSkeleton />
            )
          ) : tab === "tasks" ? (
            overview ? (
              <DeploymentTasks
                deployment={deployment}
                overview={overview}
                taskActivity={taskActivity}
                runsFrom={runsWindow.from}
              />
            ) : (
              <DetailTableTab>
                <DetailTabLoading
                  columns={TASK_COLUMNS.map((label) => ({ label }))}
                  rows={Math.min(12, Math.max(3, deployment.tasks?.length ?? 5))}
                />
              </DetailTableTab>
            )
          ) : tab === "runs" ? (
            isTabPending ? (
              <RunsTabSkeleton runsPath={runsPath} tools={runsRange} />
            ) : (
              <DeferredContent
                resolve={runList}
                retainKey={`runs:${cursor}`}
                fallback={<RunsTabSkeleton runsPath={runsPath} tools={runsRange} />}
                errorElement={
                  <DetailTabError
                    title="Couldn't load runs"
                    cause="The runs for this version didn't load. Try again, or open them in the runs list."
                  />
                }
              >
                {(list) =>
                  list ? (
                    <DetailTableTab
                      tools={runsRange}
                      actions={
                        <>
                          <OpenInRunsList to={runsPath} />
                          <ListPagination list={list} />
                        </>
                      }
                    >
                      <TaskRunsTable
                        total={list.runs.length}
                        hasFilters={list.hasFilters}
                        filters={list.filters}
                        runs={list.runs}
                        isLoading={false}
                        variant="dimmed"
                        showTopBorder={false}
                        stickyHeader
                        disableAdjacentRows
                        enableSmartColumns={false}
                      />
                    </DetailTableTab>
                  ) : (
                    <RunsTabSkeleton runsPath={runsPath} tools={runsRange} />
                  )
                }
              </DeferredContent>
            )
          ) : null}
        </DetailPage>
      </PageBody>
    </PageContainer>
  );
}

function OpenInRunsList({ to }: { to: string }) {
  return (
    <LinkButton
      variant="tertiary/small"
      to={to}
      LeadingIcon={RunsIcon}
      leadingIconClassName="text-runs"
    >
      Open in runs list
    </LinkButton>
  );
}

function RunsTabSkeleton({ runsPath, tools }: { runsPath: string; tools?: ReactNode }) {
  return (
    <DetailTableTab tools={tools} actions={<OpenInRunsList to={runsPath} />}>
      <DetailTabLoading columns={RUN_SKELETON_COLUMNS} rows={12} />
    </DetailTableTab>
  );
}

/** The Overview before its Postgres data arrives (a tab switch): every section as placeholders. */
function DeploymentOverviewSkeleton() {
  return (
    <DetailMain>
      <DetailSection>
        <DetailSectionHeading title="Runs on this version" />
        <div className="h-40">
          <ChartSkeleton />
        </div>
      </DetailSection>
      <DetailSection>
        <DetailSectionHeading title="Resources" />
        <div className="-mx-4 flex flex-col border-y border-grid-bright">
          {[0, 1, 2, 3, 4].map((row) => (
            <div
              key={row}
              className="flex h-10 items-center gap-3 border-b border-grid-dimmed px-4 last:border-b-0"
            >
              <SkeletonBone className="size-4" />
              <SkeletonBone style={{ width: `${5 + ((row * 3) % 4)}rem` }} />
              <SkeletonBone className="ml-auto w-14" />
            </div>
          ))}
        </div>
      </DetailSection>
    </DetailMain>
  );
}

function DeploymentHeader({
  deployment,
  currentVersion,
  canWriteDeployments,
  runsPath,
}: {
  deployment: Deployment;
  currentVersion: string | undefined;
  canWriteDeployments: boolean;
  runsPath: string;
}) {
  const location = useLocation();
  const isCurrent = deployment.label === "current";
  const canBeMadeCurrent = !isCurrent && deployment.status === "DEPLOYED";
  const canBeRolledBack =
    canBeMadeCurrent &&
    !!currentVersion &&
    compareDeploymentVersions(deployment.version, currentVersion) === -1;
  const canBePromoted = canBeMadeCurrent && !canBeRolledBack;
  const canBeCanceled = !FINAL_STATUSES.includes(deployment.status);
  const redirectPath = `${location.pathname}${location.search}`;
  const by = deployedByName(deployment);

  const primaryAction = canBeRolledBack ? (
    <DialogAction
      label="Rollback"
      icon={ArrowUturnLeftIcon}
      allowed={canWriteDeployments}
      deniedReason="You don't have permission to roll back deployments"
    >
      <RollbackDeploymentDialog
        projectId={deployment.projectId}
        deploymentShortCode={deployment.shortCode}
        redirectPath={redirectPath}
      />
    </DialogAction>
  ) : canBePromoted ? (
    <DialogAction
      label="Promote"
      icon={PromoteIcon}
      allowed={canWriteDeployments}
      deniedReason="You don't have permission to promote deployments"
    >
      <PromoteDeploymentDialog
        projectId={deployment.projectId}
        deploymentShortCode={deployment.shortCode}
        redirectPath={redirectPath}
      />
    </DialogAction>
  ) : canBeCanceled ? (
    <DialogAction
      label="Cancel deploy"
      icon={NoSymbolIcon}
      variant="danger/small"
      allowed={canWriteDeployments}
      deniedReason="You don't have permission to cancel deployments"
    >
      <CancelDeploymentDialog
        projectId={deployment.projectId}
        deploymentShortCode={deployment.shortCode}
        redirectPath={redirectPath}
      />
    </DialogAction>
  ) : undefined;

  return (
    <DetailHeader
      icon={DeploymentsIcon}
      iconClassName="text-deployments"
      title={deployment.version}
      badges={
        isCurrent ? (
          <Badge variant="extra-small">Current</Badge>
        ) : canBePromoted ? (
          <Badge variant="extra-small">Not promoted</Badge>
        ) : undefined
      }
      status={
        <DeploymentStatus
          status={deploymentDisplayStatus(deployment.status, !!deployment.supersededBy)}
          isBuilt={deployment.isBuilt}
        />
      }
      meta={[
        <EnvironmentCombo
          key="env"
          environment={deployment.environment}
          className="text-xs text-text-dimmed"
        />,
        ...(deployment.git
          ? [
              <span key="git" className="inline-flex items-center gap-1">
                <GitBranchIcon className="size-3" />
                {deployment.git.branchName}
                <code className="font-mono">{deployment.git.shortSha}</code>
              </span>,
            ]
          : []),
        <span key="by">
          {deployment.deployedAt ? "Deployed " : "Started "}
          <RelativeDateTime
            date={deployment.deployedAt ?? deployment.createdAt}
            capitalize={false}
          />
          {by ? ` by ${by}` : ""}
        </span>,
      ]}
      friendlyId={deployment.friendlyId}
      secondaryActions={
        deployment.tasks ? (
          <LinkButton
            variant="secondary/small"
            to={runsPath}
            LeadingIcon={RunsIcon}
            leadingIconClassName="text-runs"
          >
            View runs
          </LinkButton>
        ) : undefined
      }
      primaryAction={primaryAction}
    />
  );
}

/** A header button that opens one of the deployments list's dialogs. */
function DialogAction({
  label,
  icon,
  variant = "primary/small",
  allowed,
  deniedReason,
  children,
}: {
  label: string;
  icon: React.ComponentProps<typeof Button>["LeadingIcon"];
  variant?: "primary/small" | "danger/small";
  allowed: boolean;
  deniedReason: string;
  children: ReactNode;
}) {
  if (!allowed) {
    return (
      <Button variant={variant} LeadingIcon={icon} disabled tooltip={deniedReason}>
        {label}
      </Button>
    );
  }
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button variant={variant} LeadingIcon={icon}>
          {label}
        </Button>
      </DialogTrigger>
      {children}
    </Dialog>
  );
}

function deployedByName(deployment: Deployment) {
  if (deployment.git?.source === "trigger_github_app") {
    return deployment.git.ghUsername ?? "GitHub Integration";
  }
  return deployment.deployedBy?.name ?? deployment.deployedBy?.displayName ?? undefined;
}

function NoWorker({
  deployment,
  tab,
  hasLogs,
  onViewLogs,
}: {
  deployment: Deployment;
  tab: DeployTab;
  hasLogs: boolean;
  onViewLogs: () => void;
}) {
  const what = tab === "overview" ? undefined : tab === "tasks" ? "tasks" : "runs";
  const title =
    deployment.status === "FAILED"
      ? "This deploy failed"
      : deployment.status === "TIMED_OUT"
        ? "This deploy timed out"
        : deployment.supersededBy
          ? "This deploy was superseded"
          : deployment.status === "CANCELED"
            ? "This deploy was canceled"
            : "This deploy is still building";
  const description =
    deployment.status === "FAILED" || deployment.status === "TIMED_OUT"
      ? (deployment.errorData?.message ??
        `It never started, so there are no ${what ?? "tasks or runs"} on this version.`)
      : deployment.supersededBy
        ? `A newer commit was queued, so this build was skipped for ${deployment.supersededBy.version}.`
        : deployment.status === "CANCELED"
          ? (deployment.canceledReason ??
            `There are no ${what ?? "tasks or runs"} on this version.`)
          : `${what === "runs" ? "Runs" : "Tasks"} show up here once it's deployed.`;

  const failed = deployment.status === "FAILED" || deployment.status === "TIMED_OUT";
  const Icon = failed
    ? ExclamationTriangleIcon
    : deployment.status === "CANCELED"
      ? NoSymbolIcon
      : ClockIcon;

  // Same shape as the dashboard's other blank states (BlankStatePanels).
  return (
    <MainCenteredContainer className="max-w-md">
      <InfoPanel
        title={title}
        icon={Icon}
        iconClassName={
          failed
            ? "text-error"
            : deployment.status === "CANCELED"
              ? "text-text-dimmed"
              : "text-pending"
        }
        panelClassName="max-w-full"
        accessory={
          <Button variant="secondary/small" onClick={onViewLogs}>
            {hasLogs ? "View build logs" : "View activity"}
          </Button>
        }
      >
        <Paragraph spacing variant="small">
          {description}
        </Paragraph>
        {failed && hasLogs ? (
          <Paragraph spacing variant="small">
            The build logs show the full error and where it happened.
          </Paragraph>
        ) : null}
      </InfoPanel>
    </MainCenteredContainer>
  );
}

// ---------- Overview ----------

function DeploymentOverview({
  deployment,
  overview,
  chart,
  prompts,
  runsFrom,
}: {
  deployment: Deployment;
  overview: Overview;
  chart: ChartData;
  prompts: LoaderData["prompts"];
  runsFrom: number;
}) {
  const organization = useOrganization();
  const project = useProject();
  const environment = useEnvironment();
  const span = formatDurationMilliseconds(overview.windowMs, { style: "short", maxUnits: 1 });

  return (
    <DetailMain>
      <DetailSection>
        <DetailSectionHeading title="Runs on this version" />
        <div className="h-40">
          {/* DeferredContent draws in the browser only, where Recharts can measure. */}
          <DeferredContent
            resolve={chart}
            retainKey="overview"
            fallback={<ChartSkeleton />}
            errorElement={
              <ChartBlankState icon={RunsIcon} message="Couldn't load the runs chart" />
            }
          >
            {(activity) =>
              activity && hasRuns(activity) ? (
                <Suspense fallback={<ChartSkeleton />}>
                  <DeploymentRunsChart activity={activity} />
                </Suspense>
              ) : (
                <ChartBlankState
                  icon={RunsIcon}
                  message={`No runs on this version in its first ${span}`}
                />
              )
            }
          </DeferredContent>
        </div>
      </DetailSection>
      <DeploymentResources
        counts={overview.counts}
        previous={overview.previous?.counts}
        items={overview.resources}
        prompts={prompts}
        taskPath={(slug) =>
          v3RunsPath(organization, project, environment, {
            tasks: [slug],
            versions: [deployment.version],
            from: runsFrom,
          })
        }
      />
    </DetailMain>
  );
}

type Activity = NonNullable<Awaited<ChartData>>;

function hasRuns(activity: Activity) {
  return activity.data.some((point) =>
    activity.statuses.some((status) => Number(point[status] ?? 0) > 0)
  );
}

// ---------- Tasks ----------

const TRIGGER_SOURCE_LABEL = {
  STANDARD: "Standard",
  SCHEDULED: "Scheduled",
  WEBHOOK: "Webhook",
  AGENT: "Agent",
} as const;

const TASK_COLUMNS = ["ID", "Type", "File", "Running", "Activity (24h)"];

/** The top-level Tasks list's table, for the tasks in this version and their runs on it. */
function DeploymentTasks({
  deployment,
  overview,
  taskActivity,
  runsFrom,
}: {
  deployment: Deployment;
  overview: Overview;
  taskActivity: TaskActivity;
  runsFrom: number;
}) {
  const organization = useOrganization();
  const project = useProject();
  const environment = useEnvironment();

  return (
    <DetailTableTab>
      <Table variant="dimmed" showTopBorder={false} stickyHeader>
        <TableHeader>
          <TableRow>
            {TASK_COLUMNS.map((label) => (
              <TableHeaderCell key={label}>{label}</TableHeaderCell>
            ))}
            <TableHeaderCell hiddenLabel>Go to page</TableHeaderCell>
          </TableRow>
        </TableHeader>
        <TableBody>
          {overview.tasks.length === 0 ? (
            <TableBlankRow colSpan={TASK_COLUMNS.length + 1}>
              No tasks in this version
            </TableBlankRow>
          ) : (
            overview.tasks.map((task) => {
              const runsPath = v3RunsPath(organization, project, environment, {
                tasks: [task.slug],
                versions: [deployment.version],
                from: runsFrom,
              });
              const taskPath =
                task.triggerSource === "AGENT"
                  ? v3AgentTaskPath(organization, project, environment, task.slug)
                  : task.triggerSource === "SCHEDULED"
                    ? v3ScheduledTaskPath(organization, project, environment, task.slug)
                    : task.triggerSource === "WEBHOOK"
                      ? v3WebhookTaskPath(organization, project, environment, task.slug)
                      : v3StandardTaskPath(organization, project, environment, task.slug);
              return (
                <TableRow key={task.slug} className="group">
                  <TableCell to={runsPath} isTabbableCell>
                    <div className="flex items-center gap-2">
                      <SimpleTooltip
                        button={<TaskTriggerSourceIcon source={task.triggerSource} />}
                        content={taskTriggerSourceDescription(task.triggerSource)}
                        disableHoverableContent
                      />
                      {/* Long ids truncate so the table fits beside the rail at 1280. */}
                      <span className="max-w-36 truncate" title={task.slug}>
                        {task.slug}
                      </span>
                      {task.added ? <Badge variant="extra-small">New</Badge> : null}
                    </div>
                  </TableCell>
                  <TableCell to={runsPath}>{TRIGGER_SOURCE_LABEL[task.triggerSource]}</TableCell>
                  <TableCell to={runsPath}>
                    {/* The tasks list's file chip, cut from the left so the file name stays. */}
                    <InlineCode
                      variant="extra-extra-small"
                      className="block max-w-28 truncate text-left text-text-dimmed [direction:rtl]"
                    >
                      <bdi title={task.filePath}>{task.filePath}</bdi>
                    </InlineCode>
                  </TableCell>
                  <TableCell to={runsPath}>
                    <TaskStat
                      activity={taskActivity}
                      fallback={<Spinner color="blue" className="size-3" />}
                    >
                      {(data) => {
                        const running = data.running[task.slug];
                        return running ? (
                          formatNumber(running)
                        ) : (
                          <span className="text-text-dimmed">0</span>
                        );
                      }}
                    </TaskStat>
                  </TableCell>
                  <TableCell to={runsPath} actionClassName="py-1.5">
                    <div style={{ width: ACTIVITY_CELL_WIDTH, height: ACTIVITY_CHART_HEIGHT }}>
                      <TaskStat activity={taskActivity} fallback={<ActivityBarChartBlankState />}>
                        {(data) => {
                          const buckets = data.hourly[task.slug];
                          return buckets && buckets.length > 0 ? (
                            <TaskActivityGraph activity={buckets} />
                          ) : (
                            <ActivityBarChartBlankState />
                          );
                        }}
                      </TaskStat>
                    </div>
                  </TableCell>
                  <TableCellMenu
                    isSticky
                    popoverContent={
                      <>
                        <PopoverMenuItem
                          icon={RunsIcon}
                          to={runsPath}
                          title="View runs on this version"
                          leadingIconClassName="-mx-1 text-runs"
                        />
                        <PopoverMenuItem
                          icon={TasksIcon}
                          to={taskPath}
                          title="View task"
                          leadingIconClassName="-mx-1 text-tasks"
                        />
                      </>
                    }
                  />
                </TableRow>
              );
            })
          )}
        </TableBody>
      </Table>
    </DetailTableTab>
  );
}

/**
 * A cell's deferred stat, rendered in the browser only, like the tasks list: a streamed Suspense
 * boundary still pending at hydration would otherwise bail to client rendering (React #421).
 */
function TaskStat({
  activity,
  fallback,
  children,
}: {
  activity: TaskActivity;
  fallback: ReactNode;
  children: (data: Awaited<TaskActivity>) => ReactNode;
}) {
  return (
    <ClientOnly fallback={fallback}>
      {() => (
        <Suspense fallback={fallback}>
          <TypedAwait resolve={activity} errorElement={<span className="text-text-dimmed">–</span>}>
            {(data) => children(data)}
          </TypedAwait>
        </Suspense>
      )}
    </ClientOnly>
  );
}

// ---------- Activity ----------

function between(from: Date | null, to: Date | null) {
  if (!from || !to || to.getTime() <= from.getTime()) return undefined;
  return formatDurationMilliseconds(to.getTime() - from.getTime(), {
    style: "short",
  });
}

function stepTime(at: Date, duration?: string) {
  return (
    <>
      <DateTimeAccurate date={at} />
      {duration ? ` · ${duration}` : ""}
    </>
  );
}

/** The deploy's timeline from the timestamps it stores. */
function deploySteps(deployment: Deployment): ActivityStep[] {
  const failed = deployment.status === "FAILED" || deployment.status === "TIMED_OUT";
  const stopped = failed || deployment.status === "CANCELED";
  const steps: ActivityStep[] = [
    {
      status: "ok",
      title: "Queued",
      description: triggeredViaLabel(deployment.triggeredVia),
      time: stepTime(deployment.createdAt, between(deployment.createdAt, deployment.startedAt)),
    },
  ];

  if (deployment.startedAt) {
    steps.push({
      status: "ok",
      title: "Started",
      description: deployment.installedAt ? "Installing dependencies" : "Building the image",
      time: stepTime(
        deployment.startedAt,
        between(deployment.startedAt, deployment.installedAt ?? deployment.builtAt)
      ),
    });
  }
  if (deployment.installedAt) {
    steps.push({
      status: "ok",
      title: "Installed",
      description: "Building the image",
      time: stepTime(deployment.installedAt, between(deployment.installedAt, deployment.builtAt)),
    });
  }
  if (deployment.builtAt) {
    steps.push({
      status: "ok",
      title: "Built",
      description: deployment.imagePlatform ? `Image ${deployment.imagePlatform}` : undefined,
      time: stepTime(deployment.builtAt, between(deployment.builtAt, deployment.deployedAt)),
    });
  } else if (!stopped && deployment.status !== "DEPLOYED") {
    steps.push({ status: "running", title: "Building" });
  }

  if (deployment.deployedAt) {
    steps.push({
      status: "ok",
      title: "Deployed",
      description: deployment.tasks
        ? `${formatNumber(deployment.tasks.length)} ${deployment.tasks.length === 1 ? "task" : "tasks"} indexed`
        : undefined,
      time: stepTime(deployment.deployedAt),
    });
  } else if (failed) {
    steps.push({
      status: "fail",
      title:
        deployment.status === "TIMED_OUT"
          ? "Timed out"
          : deployment.builtAt
            ? "Deploy failed"
            : "Build failed",
      description: deployment.errorData?.name,
      time: deployment.failedAt ? stepTime(deployment.failedAt) : undefined,
    });
    steps.push({ status: "pending", title: "Deploy", description: "Skipped" });
  } else if (deployment.status === "CANCELED") {
    steps.push({
      status: "fail",
      title: deployment.supersededBy ? "Superseded" : "Canceled",
      description: deployment.supersededBy
        ? `By ${deployment.supersededBy.version}`
        : (deployment.canceledReason ?? undefined),
      time: deployment.canceledAt ? stepTime(deployment.canceledAt) : undefined,
    });
  } else if (deployment.builtAt) {
    steps.push({ status: "running", title: "Deploying" });
  }

  if (deployment.label === "current") {
    steps.push({ status: "ok", title: "Current", description: "New runs use this version" });
  }
  return steps;
}

function DeploymentActivity({
  deployment,
  onViewLogs,
}: {
  deployment: Deployment;
  onViewLogs?: () => void;
}) {
  const error = deployment.errorData;
  return (
    <DetailMain>
      <div className="mx-auto flex w-full max-w-prose flex-col gap-6 pt-6">
        <ActivityTimeline
          steps={deploySteps(deployment)}
          failure={
            error
              ? {
                  title: error.name ?? "Deploy failed",
                  description: error.message,
                  action: onViewLogs ? (
                    <Button variant="secondary/small" onClick={onViewLogs}>
                      View build logs
                    </Button>
                  ) : undefined,
                }
              : undefined
          }
        />
        {error?.stack ? (
          <DetailSection>
            <DetailSectionHeading title="Stack trace" />
            <CodeBlock
              showCopyButton
              showLineNumbers={false}
              code={error.stack}
              maxLines={20}
              showTextWrapping
            />
          </DetailSection>
        ) : null}
        {error?.stderr ? (
          <DetailSection>
            <DetailSectionHeading title="Error logs" />
            <CodeBlock
              showCopyButton
              showLineNumbers={false}
              code={error.stderr}
              maxLines={20}
              showTextWrapping
            />
          </DetailSection>
        ) : null}
      </div>
    </DetailMain>
  );
}

// ---------- Rail ----------

function DeploymentRail({ deployment }: { deployment: Deployment }) {
  const organization = useOrganization();
  const project = useProject();
  const environment = useEnvironment();
  const by = deployedByName(deployment);
  const triggeredVia = triggeredViaDisplay(deployment.triggeredVia);

  return (
    <PropertyRail>
      <PropertyGroup title="Details">
        <DetailProperty label="ID">
          <CopyableText value={deployment.friendlyId} className="font-mono text-xs" truncate />
        </DetailProperty>
        <PropertyPair>
          <DetailProperty label="Status">
            <DeploymentStatus
              status={deploymentDisplayStatus(deployment.status, !!deployment.supersededBy)}
              isBuilt={deployment.isBuilt}
            />
          </DetailProperty>
          <DetailProperty label="Environment">
            <EnvironmentCombo environment={deployment.environment} />
          </DetailProperty>
          <DetailProperty label="Created">
            <DateTime date={deployment.createdAt} />
          </DetailProperty>
          <DetailProperty label="Deployed">
            {deployment.deployedAt ? <DateTime date={deployment.deployedAt} /> : "–"}
          </DetailProperty>
        </PropertyPair>
        {deployment.supersededBy ? (
          <DetailProperty label="Superseded by">
            <TextLink
              to={v3DeploymentPath(organization, project, environment, deployment.supersededBy, 0)}
            >
              {deployment.supersededBy.version}
            </TextLink>
          </DetailProperty>
        ) : deployment.canceledAt ? (
          <DetailProperty label="Canceled">
            <DateTime date={deployment.canceledAt} />
            {deployment.canceledReason ? ` (${deployment.canceledReason})` : null}
          </DetailProperty>
        ) : null}
      </PropertyGroup>
      <PropertyGroup title="Build">
        <PropertyPair>
          <DetailProperty label="Version">{deployment.version}</DetailProperty>
          <DetailProperty label="Deploy">{deployment.shortCode}</DetailProperty>
          <DetailProperty label="Build time">
            {between(deployment.startedAt, deployment.builtAt) ?? "–"}
          </DetailProperty>
          <DetailProperty label="Worker type">{capitalizeWord(deployment.type)}</DetailProperty>
          <DetailProperty label="Platform">{deployment.imagePlatform}</DetailProperty>
          <DetailProperty label="External ID">
            {deployment.externalId ? (
              <CopyableText value={deployment.externalId} className="font-mono text-xs" truncate />
            ) : (
              "–"
            )}
          </DetailProperty>
        </PropertyPair>
        {deployment.redeployOf ? (
          <DetailProperty label="Redeploy of">
            <TextLink
              to={v3DeploymentPath(
                organization,
                project,
                environment,
                { shortCode: deployment.redeployOf },
                0
              )}
            >
              {deployment.redeployOf}
            </TextLink>
          </DetailProperty>
        ) : null}
      </PropertyGroup>
      <PropertyGroup title="Runtime">
        <PropertyPair>
          <DetailProperty label="SDK version">{deployment.sdkVersion ?? "–"}</DetailProperty>
          <DetailProperty label="CLI version">
            {deployment.cliVersionWarning ? (
              <>
                <TruncatedText text={deployment.cliVersion ?? "–"} />
                <CliVersionWarningBadge warning={deployment.cliVersionWarning} />
              </>
            ) : (
              (deployment.cliVersion ?? "–")
            )}
          </DetailProperty>
        </PropertyPair>
        <DetailProperty label="Runtime">
          <RuntimeIcon
            runtime={deployment.runtime}
            runtimeVersion={deployment.runtimeVersion}
            withLabel
          />
        </DetailProperty>
      </PropertyGroup>
      <PropertyGroup title="Source">
        <DetailProperty label="Git">
          {deployment.git ? (
            <div className="-ml-1 flex flex-col">
              <GitMetadata git={deployment.git} />
            </div>
          ) : (
            "–"
          )}
        </DetailProperty>
        <PropertyPair>
          <DetailProperty label="Deployed by">
            {by ? (
              <UserTag
                name={by}
                avatarUrl={
                  deployment.git?.source === "trigger_github_app"
                    ? deployment.git.ghUserAvatarUrl
                    : (deployment.deployedBy?.avatarUrl ?? undefined)
                }
              />
            ) : (
              "–"
            )}
          </DetailProperty>
          <DetailProperty label="Triggered via">
            {triggeredVia ? (
              <span className="flex items-center gap-1.5">
                {triggeredVia.icon}
                {triggeredVia.label}
              </span>
            ) : (
              "–"
            )}
          </DetailProperty>
        </PropertyPair>
        {deployment.vercelDeploymentUrl ? (
          <DetailProperty label="Linked">
            <div className="-ml-1 flex flex-col">
              <VercelLink vercelDeploymentUrl={deployment.vercelDeploymentUrl} />
            </div>
          </DetailProperty>
        ) : null}
      </PropertyGroup>
    </PropertyRail>
  );
}

function AdminDebug({ deployment }: { deployment: Deployment }) {
  return (
    <AdminDebugTooltip>
      <Property.Table>
        <Property.Item>
          <Property.Label>ID</Property.Label>
          <Property.Value>
            <CopyableText value={deployment.id} asChild hideTooltip />
          </Property.Value>
        </Property.Item>
        <Property.Item>
          <Property.Label>Project ID</Property.Label>
          <Property.Value>
            <CopyableText value={deployment.projectId} asChild hideTooltip />
          </Property.Value>
        </Property.Item>
        <Property.Item>
          <Property.Label>Org ID</Property.Label>
          <Property.Value>
            <CopyableText value={deployment.organizationId} asChild hideTooltip />
          </Property.Value>
        </Property.Item>
        {deployment.imageReference && (
          <Property.Item>
            <Property.Label>Image</Property.Label>
            <Property.Value>
              <CopyableText value={deployment.imageReference} asChild hideTooltip />
            </Property.Value>
          </Property.Item>
        )}
        {deployment.externalBuildData && (
          <Property.Item>
            <Property.Label>Build Server</Property.Label>
            <Property.Value>
              <TextLink
                to={`/resources/${deployment.projectId}/deployments/${deployment.id}/logs`}
                className="font-mono text-xs"
              >
                {deployment.externalBuildData.buildId}
              </TextLink>
            </Property.Value>
          </Property.Item>
        )}
      </Property.Table>
    </AdminDebugTooltip>
  );
}

function triggeredViaLabel(triggeredVia: string | null | undefined) {
  const display = triggeredViaDisplay(triggeredVia);
  return display ? `From ${display.label}` : undefined;
}

function triggeredViaDisplay(
  triggeredVia: string | null | undefined
): { icon: ReactNode; label: string } | null {
  if (!triggeredVia) return null;

  const iconClass = "size-4 text-text-dimmed";
  const labels: Record<string, string> = {
    "cli:manual": "CLI (Manual)",
    "cli:github_actions": "CLI (GitHub Actions)",
    "cli:gitlab_ci": "CLI (GitLab CI)",
    "cli:circleci": "CLI (CircleCI)",
    "cli:jenkins": "CLI (Jenkins)",
    "cli:azure_pipelines": "CLI (Azure Pipelines)",
    "cli:bitbucket_pipelines": "CLI (Bitbucket Pipelines)",
    "cli:travis_ci": "CLI (Travis CI)",
    "cli:buildkite": "CLI (Buildkite)",
    "cli:ci_other": "CLI (CI)",
    "git_integration:github": "GitHub Integration",
    dashboard: "Dashboard",
  };
  const label =
    labels[triggeredVia] ??
    (triggeredVia.startsWith("cli:") ? `CLI (${triggeredVia.replace("cli:", "")})` : triggeredVia);
  const icon =
    triggeredVia === "dashboard" ? (
      <LayoutDashboardIcon className={iconClass} />
    ) : triggeredVia === "cli:github_actions" || triggeredVia === "git_integration:github" ? (
      <GitBranchIcon className={iconClass} />
    ) : triggeredVia.startsWith("cli:") &&
      (triggeredVia === "cli:manual" || !labels[triggeredVia]) ? (
      <TerminalSquareIcon className={iconClass} />
    ) : (
      <ServerIcon className={iconClass} />
    );
  return { icon, label };
}
