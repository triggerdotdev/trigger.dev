import { GlobeLinesIcon } from "~/assets/icons/GlobeLinesIcon";
import {
  ArrowPathIcon,
  BookOpenIcon,
  CheckIcon,
  ChevronUpIcon,
  ClipboardDocumentIcon,
  ClockIcon,
  CloudArrowDownIcon,
  KeyIcon,
  QueueListIcon,
  SignalIcon,
} from "@heroicons/react/20/solid";
import { useParams } from "@remix-run/react";
import { type LoaderFunctionArgs } from "@remix-run/server-runtime";
import { formatDurationMilliseconds, type RunExecutionPolicy } from "@trigger.dev/core/v3";
import { assertNever } from "assert-never";
import { useEffect } from "react";
import { typedjson, useTypedFetcher } from "remix-typedjson";
import { toast } from "sonner";
import { ExitIcon } from "~/assets/icons/ExitIcon";
import { useDocsLink } from "~/components/DocsPanel";
import { AdminDebugRun } from "~/components/admin/debugRun";
import { CodeBlock } from "~/components/code/CodeBlock";
import { RunError } from "~/components/runs/v3/RunError";
import { EnvironmentCombo } from "~/components/environments/EnvironmentLabel";
import { MachineLabelCombo } from "~/components/MachineLabelCombo";
import { MachineTooltipInfo } from "~/components/MachineTooltipInfo";
import { Button, LinkButton } from "~/components/primitives/Buttons";
import { InvestigateButton } from "~/components/dashboard-agent/InvestigateButton";
import {
  failedRunPrompt,
  isFailedRunStatus,
  isInProgressRunStatus,
  runningRunPrompt,
} from "~/components/dashboard-agent/investigate-prompts";
import { Callout } from "~/components/primitives/Callout";
import { CopyableText } from "~/components/primitives/CopyableText";
import { CopyTextLink } from "~/components/primitives/CopyTextLink";
import { DateTime, DateTimeAccurate } from "~/components/primitives/DateTime";
import { Header2, Header3 } from "~/components/primitives/Headers";
import { Paragraph } from "~/components/primitives/Paragraph";
import { Badge } from "~/components/primitives/Badge";
import {
  Popover,
  PopoverContent,
  PopoverMenuItem,
  PopoverTrigger,
} from "~/components/primitives/Popover";
import * as Property from "~/components/primitives/PropertyTable";
import { Spinner } from "~/components/primitives/Spinner";
import {
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
} from "~/components/primitives/Table";
import { TabButton, TabContainer } from "~/components/primitives/Tabs";
import { TextLink } from "~/components/primitives/TextLink";
import { ToastUI } from "~/components/primitives/Toast";
import { InfoIconTooltip, SimpleTooltip } from "~/components/primitives/Tooltip";
import { TruncatedCopyableValue } from "~/components/primitives/TruncatedCopyableValue";
import { RunTimeline, RunTimelineEvent, SpanTimeline } from "~/components/run/RunTimeline";
import { RunContinuationProperties } from "~/components/sessions/v1/SessionHandover";
import { AIEmbedSpanDetails, AISpanDetails, AIToolCallSpanDetails } from "~/components/runs/v3/ai";
import { PacketDisplay } from "~/components/runs/v3/PacketDisplay";
import { PromptSpanDetails } from "~/components/runs/v3/PromptSpanDetails";
import { RegionLabel } from "~/components/runs/v3/RegionLabel";
import { RunIcon } from "~/components/runs/v3/RunIcon";
import { RunTag } from "~/components/runs/v3/RunTag";
import { SpanEvents } from "~/components/runs/v3/SpanEvents";
import { SpanHorizontalTimeline } from "~/components/runs/v3/SpanHorizontalTimeline";
import { SpanTitle } from "~/components/runs/v3/SpanTitle";
import { TaskRunAttemptStatusCombo } from "~/components/runs/v3/TaskRunAttemptStatus";
import {
  descriptionForTaskRunStatus,
  TaskRunStatusCombo,
} from "~/components/runs/v3/TaskRunStatus";
import { WaitpointDetailTable } from "~/components/runs/v3/WaitpointDetails";
import { RuntimeIcon } from "~/components/RuntimeIcon";
import { SessionStatusCombo } from "~/components/sessions/v1/SessionStatus";
import { SESSION_RUN_PARAM } from "~/components/sessions/v1/trace/sessionTraceSelection";
import type { SessionStatus } from "~/services/sessionsRepository/sessionsRepository.server";
import { WarmStartCombo } from "~/components/WarmStarts";
import { useEnvironment } from "~/hooks/useEnvironment";
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
import { useSearchParams } from "~/hooks/useSearchParam";
import { useHasAdminAccess } from "~/hooks/useUser";
import { redirectWithErrorMessage } from "~/models/message.server";
import {
  resolveRunQueueMetrics,
  type RunQueueMetrics,
} from "~/presenters/v3/RunQueueMetricsPresenter.server";
import { resolvePendingVersion } from "~/presenters/v3/PendingVersionPresenter.server";
import { type Span, SpanPresenter, type SpanRun } from "~/presenters/v3/SpanPresenter.server";
import { buildRunWaitingView } from "~/presenters/v3/RunWaitingPresenter.server";
import { isExplainedExpiry, type RunWaitingView } from "~/presenters/v3/runWaiting";
import { NotStartedCard, NotStartedStatus } from "~/components/runs/v3/NotStarted";
import { type StartedSession } from "~/presenters/v3/startedSession.server";
import { findProjectWithOrgFlagsBySlug } from "~/models/project.server";
import { logger } from "~/services/logger.server";
import { rbac } from "~/services/rbac.server";
import { hasAdminDisplayAccess, requireUser } from "~/services/session.server";
import { canUseAlertsList } from "~/v3/canUseAlertsList.server";
import { cn } from "~/utils/cn";
import { $replica } from "~/db.server";
import { VersionLabel } from "~/components/versions/VersionLabel";
import { findCurrentVersion } from "~/v3/models/workerDeployment.server";
import { formatCurrencyAccurate } from "~/utils/numberFormatter";
import {
  docsPath,
  v3BatchPath,
  concurrencyQueuePath,
  v3RunDownloadLogsPath,
  v3RunIdempotencyKeyResetPath,
  v3RunPath,
  v3RunRedirectPath,
  v3RunSpanPath,
  v3RunsPath,
  v3ScheduledTaskSchedulePath,
  v3WebhookDeliveryPath,
  v3WebhookEndpointPath,
  v3SessionPath,
  v3SpanParamsSchema,
} from "~/utils/pathBuilder";
import { createTimelineSpanEventsFromSpanEvents } from "~/utils/timelineSpanEvents";
import type { SpanOverride } from "~/v3/eventRepository/eventRepository.types";
import { type action as resetIdempotencyKeyAction } from "../resources.orgs.$organizationSlug.projects.$projectParam.env.$envParam.runs.$runParam.idempotencyKey.reset";
import { RealtimeStreamViewer } from "../resources.orgs.$organizationSlug.projects.$projectParam.env.$envParam.runs.$runParam.streams.$streamKey/route";
import { CompleteWaitpointForm } from "../resources.orgs.$organizationSlug.projects.$projectParam.env.$envParam.waitpoints.$waitpointFriendlyId.complete/route";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const user = await requireUser(request);
  const userId = user.id;
  const showAdminFields = hasAdminDisplayAccess(user);
  const { projectParam, organizationSlug, envParam, runParam, spanParam } =
    v3SpanParamsSchema.parse(params);

  const project = await findProjectWithOrgFlagsBySlug(organizationSlug, projectParam, userId);
  if (!project) throw new Response("Project not found", { status: 404 });

  const auth = await rbac.authenticateSession(request, {
    userId,
    organizationId: project.organizationId,
    projectId: project.id,
  });
  const canWriteRuns = auth.ok && auth.ability.can("write", { type: "runs" });

  const url = new URL(request.url);
  const linkedRunId = url.searchParams.get("linkedRunId") ?? undefined;

  const presenter = new SpanPresenter();

  try {
    const result = await presenter.call({
      projectSlug: projectParam,
      envSlug: envParam,
      spanId: spanParam,
      runFriendlyId: runParam,
      userId,
      linkedRunId,
      showDebug: user.admin || user.isImpersonating,
    });

    if (!result) {
      return redirectWithErrorMessage(
        v3RunPath(
          { slug: organizationSlug },
          { slug: projectParam },
          { slug: envParam },
          { friendlyId: runParam }
        ),
        request,
        `Event not found.`
      );
    }

    // Reconstruct the discriminated union explicitly. Spreading
    // `{ ...result }` collapses the union and loses the
    // `type === "run" | "span"` discriminant downstream in `SpanView`.
    if (result.type === "run") {
      const queueMetrics = await resolveRunQueueMetrics({
        request,
        userId,
        organizationSlug,
        projectParam,
        envParam,
        run: result.run,
      });
      const pendingVersion =
        result.run.status === "PENDING_VERSION" ||
        result.run.status === "WAITING_FOR_DEPLOY" ||
        isExplainedExpiry(result.run.status, result.run.statusReason)
          ? await resolvePendingVersion({
              environmentId: result.run.environmentId,
              taskIdentifier: result.run.taskIdentifier,
              queueName: result.run.queue.name,
              statusReason: result.run.statusReason,
              lockedVersion: result.run.version,
              externalDeploymentId: result.run.externalDeploymentId,
            })
          : null;
      const waitingView = await buildRunWaitingView({
        run: {
          status: result.run.status,
          createdAt: result.run.createdAt,
          queuedAt: result.run.queuedAt,
          delayUntil: result.run.delayUntil,
          ttl: result.run.ttl,
          debounce: result.run.debounce,
          statusReason: result.run.statusReason,
          expiredAt: result.run.expiredAt,
          environmentId: result.run.environmentId,
          taskIdentifier: result.run.taskIdentifier,
          queueName: result.run.queue.name,
          lockedVersion: result.run.version,
        },
        queueMetrics,
        pendingVersion,
        canManageQueues: auth.ok && auth.ability.can("write", { type: "tasks" }),
      });
      // Tags the run's version as Current or Not promoted on the Version row.
      const runEnvironment = result.run.version
        ? await $replica.runtimeEnvironment.findFirst({
            where: { id: result.run.environmentId },
            select: { id: true, type: true },
          })
        : null;
      const currentVersion = runEnvironment
        ? await findCurrentVersion(runEnvironment, $replica)
        : undefined;
      const alertsEnabled = await canUseAlertsList({
        orgFeatureFlags: (project.organization.featureFlags as Record<string, unknown>) ?? {},
        userId,
      });
      return typedjson({
        type: "run" as const,
        run: showAdminFields
          ? result.run
          : { ...result.run, workerCell: undefined, workerLane: undefined },
        queueMetrics,
        waitingView,
        canWriteRuns,
        alertsEnabled,
        currentVersion,
      });
    }
    return typedjson({ type: "span" as const, span: result.span });
  } catch (error) {
    logger.error("Error loading span", {
      projectParam,
      organizationSlug,
      runParam,
      spanParam,
      linkedRunId,
      error:
        error instanceof Error
          ? {
              name: error.name,
              message: error.message,
              stack: error.stack,
              cause:
                error.cause instanceof Error
                  ? { name: error.cause.name, message: error.cause.message }
                  : error.cause,
            }
          : error,
    });
    return redirectWithErrorMessage(
      v3RunPath(
        { slug: organizationSlug },
        { slug: projectParam },
        { slug: envParam },
        { friendlyId: runParam }
      ),
      request,
      `Event not found.`
    );
  }
};

export function SpanView({
  runParam,
  spanId,
  spanOverrides,
  closePanel,
  linkedRunId,
  refreshKey,
  tabParam = "tab",
  hideFocusOnRun = false,
  statusAccessory,
}: {
  runParam: string;
  spanId: string | undefined;
  spanOverrides?: SpanOverride;
  closePanel?: () => void;
  linkedRunId?: string;
  /** Changing it reloads the span. */
  refreshKey?: number;
  /** The search param that holds the panel's tab, so a page can keep `tab` for its own tabs. */
  tabParam?: string;
  hideFocusOnRun?: boolean;
  /**
   * Shown at the end of the status line, e.g. a link to the run page. A panel without a status
   * line (a log, a not-started run) shows it in the header instead.
   */
  statusAccessory?: React.ReactNode;
}) {
  const organization = useOrganization();
  const project = useProject();
  const environment = useEnvironment();
  const fetcher = useTypedFetcher<typeof loader>();
  const { load } = fetcher;

  useEffect(() => {
    if (spanId === undefined) return;
    const url = `/resources/orgs/${organization.slug}/projects/${project.slug}/env/${
      environment.slug
    }/runs/${runParam}/spans/${spanId}${linkedRunId ? `?linkedRunId=${linkedRunId}` : ""}`;
    load(url);
  }, [
    organization.slug,
    project.slug,
    environment.slug,
    runParam,
    spanId,
    linkedRunId,
    load,
    refreshKey,
  ]);

  if (spanId === undefined) {
    return null;
  }

  // Only show loading spinner when there's no data yet, not during revalidation
  if (fetcher.data === undefined) {
    return (
      <div
        className={cn(
          "grid h-full max-h-full grid-rows-[2.5rem_1fr] overflow-hidden bg-background-bright"
        )}
      >
        <div className="mx-3 flex items-center gap-2 overflow-x-hidden border-b border-grid-dimmed">
          <div className="size-4 bg-grid-dimmed" />
          <div className="h-6 w-[60%] bg-grid-dimmed" />
        </div>
        <div className="flex items-center justify-center">
          <Spinner />
        </div>
      </div>
    );
  }

  const { type } = fetcher.data;

  switch (type) {
    case "run": {
      return (
        <RunBody
          run={fetcher.data.run}
          queueMetrics={fetcher.data.queueMetrics}
          waitingView={fetcher.data.waitingView}
          canWriteRuns={fetcher.data.canWriteRuns}
          alertsEnabled={fetcher.data.alertsEnabled}
          currentVersion={fetcher.data.currentVersion}
          runParam={runParam}
          spanId={spanId}
          closePanel={closePanel}
          tabParam={tabParam}
          hideFocusOnRun={hideFocusOnRun}
          statusAccessory={statusAccessory}
        />
      );
    }
    case "span": {
      return (
        <SpanBody
          span={fetcher.data.span}
          spanOverrides={spanOverrides}
          runParam={runParam}
          closePanel={closePanel}
          tabParam={tabParam}
          statusAccessory={statusAccessory}
        />
      );
    }
  }
}

function SpanBody({
  span,
  spanOverrides,
  runParam,
  closePanel,
  tabParam,
  statusAccessory,
}: {
  span: Span;
  spanOverrides?: SpanOverride;
  runParam?: string;
  closePanel?: () => void;
  tabParam: string;
  statusAccessory?: React.ReactNode;
}) {
  const _organization = useOrganization();
  const _project = useProject();
  const _environment = useEnvironment();
  const { value, replace: _replace } = useSearchParams();
  let tab = value(tabParam);

  if (tab === "context") {
    tab = "overview";
  }

  span = applySpanOverrides(span, spanOverrides);

  const isAiInspector =
    span.entity?.type === "ai-generation" ||
    span.entity?.type === "ai-summary" ||
    span.entity?.type === "ai-tool-call" ||
    span.entity?.type === "ai-embed" ||
    span.entity?.type === "prompt";

  return (
    <div
      className={cn(
        "grid h-full max-h-full overflow-hidden bg-background-bright",
        isAiInspector ? "grid-rows-[auto_1fr]" : "grid-rows-[2.5rem_1fr]"
      )}
    >
      <div className="border-b border-grid-bright px-3 pr-2">
        <div className="grid h-10 grid-cols-[minmax(0,1fr)_auto] items-center gap-2">
          <div className="flex min-w-0 items-center gap-1">
            <RunIcon
              name={span.style?.icon}
              spanName={span.message}
              className="size-5 min-h-5 min-w-5"
            />
            <Header2 className="min-w-0">
              <SpanTitle {...span} size="large" hideAccessory overrideDimmed />
            </Header2>
          </div>
          {panelHeaderActions(
            spanHasStatusLine(span) ? undefined : statusAccessory,
            runParam && closePanel && (
              <Button
                onClick={closePanel}
                variant="minimal/small"
                TrailingIcon={ExitIcon}
                shortcut={{ key: "esc" }}
                shortcutPosition="before-trailing-icon"
                className="pl-1"
              />
            )
          )}
        </div>
      </div>
      {isAiInspector ? (
        <SpanEntity span={span} statusAccessory={statusAccessory} />
      ) : (
        <div className="scrollbar-gutter-stable overflow-y-auto scrollbar-thin scrollbar-track-transparent scrollbar-thumb-surface-control">
          <SpanEntity span={span} statusAccessory={statusAccessory} />
        </div>
      )}
    </div>
  );
}
/** A normal traced span shows its status first; logs and entity spans don't. */
function spanHasStatusLine(span: Span) {
  return !span.entity && span.level === "TRACE";
}

/** The header's right side: an optional accessory, then the close button. */
function panelHeaderActions(accessory: React.ReactNode, closeButton: React.ReactNode) {
  if (!accessory) return closeButton;

  return (
    <div className="flex items-center gap-1">
      {accessory}
      {closeButton}
    </div>
  );
}

function applySpanOverrides(span: Span, spanOverrides?: SpanOverride): Span {
  if (!spanOverrides) {
    return span;
  }

  const newSpan = { ...span };

  if (spanOverrides.isCancelled) {
    newSpan.isCancelled = true;
    newSpan.isPartial = false;
    newSpan.isError = false;
  } else if (spanOverrides.isError) {
    newSpan.isError = true;
    newSpan.isPartial = false;
    newSpan.isCancelled = false;
  }

  if (typeof spanOverrides.duration !== "undefined") {
    newSpan.duration = spanOverrides.duration;
  }

  if (spanOverrides.events) {
    if (newSpan.events) {
      newSpan.events = [...newSpan.events, ...spanOverrides.events];
    } else {
      newSpan.events = spanOverrides.events;
    }
  }

  return newSpan;
}

function RunBody({
  run,
  queueMetrics,
  waitingView,
  canWriteRuns,
  alertsEnabled,
  currentVersion,
  runParam,
  spanId,
  closePanel,
  tabParam,
  hideFocusOnRun,
  statusAccessory,
}: {
  run: SpanRun;
  queueMetrics: RunQueueMetrics | null;
  waitingView: RunWaitingView | null;
  canWriteRuns: boolean;
  alertsEnabled: boolean;
  currentVersion: string | undefined;
  runParam: string;
  spanId: string;
  closePanel?: () => void;
  tabParam: string;
  hideFocusOnRun: boolean;
  statusAccessory?: React.ReactNode;
}) {
  const organization = useOrganization();
  const project = useProject();
  const environment = useEnvironment();
  const isAdmin = useHasAdminAccess();
  const { value, replace } = useSearchParams();
  const tab = value(tabParam);
  const resetFetcher = useTypedFetcher<typeof resetIdempotencyKeyAction>();
  const handedOverTo = run.session?.handedOverTo;
  const continuedFrom = run.session?.continuedFrom;

  const queuePath = queueMetrics?.queueFriendlyId
    ? concurrencyQueuePath(organization, project, environment, {
        friendlyId: queueMetrics.queueFriendlyId,
      })
    : undefined;

  return (
    <div className="grid h-full max-h-full grid-rows-[2.5rem_2rem_1fr_minmax(3.25rem,auto)] overflow-hidden bg-background-bright">
      <div className="flex items-center justify-between gap-2 overflow-x-hidden px-3 pr-2">
        <div className="flex items-center gap-1 overflow-x-hidden">
          <RunIcon
            name={
              run.isAgentRun
                ? "agent"
                : run.isScheduled
                  ? "scheduled"
                  : run.isWebhook
                    ? "webhook"
                    : run.isCached
                      ? "task-cached"
                      : "task"
            }
            spanName={run.taskIdentifier}
            className="size-5 min-h-5 min-w-5"
          />
          <Header2
            className={cn(
              "overflow-x-hidden",
              // The run-type accents are drawn for 3:1 as icons; as 16px text the
              // tasks and agents blues fall under 4.5:1 on the light themes, so
              // the title takes the text colour there and the icon carries type.
              run.isAgentRun
                ? "text-agents"
                : run.isScheduled
                  ? "text-schedules"
                  : run.isWebhook
                    ? "text-webhooks"
                    : "text-tasks",
              "light:text-text-bright"
            )}
          >
            <span className="truncate">
              {run.taskIdentifier}
              {run.isCached ? " (cached)" : null}
            </span>
          </Header2>
          {run.executionPolicy && <Badge variant="extra-small">Sandbox</Badge>}
        </div>
        {panelHeaderActions(
          // The status line is on Overview only; elsewhere (and for a not-started run) it's here.
          waitingView || (tab && tab !== "overview") ? statusAccessory : undefined,
          runParam && closePanel && (
            <Button
              onClick={closePanel}
              variant="minimal/small"
              TrailingIcon={ExitIcon}
              shortcut={{ key: "esc" }}
              shortcutPosition="before-trailing-icon"
              className="pl-1"
            />
          )
        )}
      </div>
      <div className="h-fit overflow-x-auto px-3 scrollbar-thin scrollbar-track-transparent scrollbar-thumb-surface-control">
        <TabContainer>
          <TabButton
            isActive={!tab || tab === "overview"}
            layoutId="span-run"
            onClick={() => {
              replace({ [tabParam]: "overview" });
            }}
            shortcut={{ key: "o" }}
          >
            Overview
          </TabButton>
          <TabButton
            isActive={tab === "detail"}
            layoutId="span-run"
            onClick={() => {
              replace({ [tabParam]: "detail" });
            }}
            shortcut={{ key: "d" }}
          >
            Detail
          </TabButton>
          <TabButton
            isActive={tab === "context"}
            layoutId="span-run"
            onClick={() => {
              replace({ [tabParam]: "context" });
            }}
            shortcut={{ key: "x" }}
          >
            Context
          </TabButton>

          <TabButton
            isActive={tab === "metadata"}
            layoutId="span-run"
            onClick={() => {
              replace({ [tabParam]: "metadata" });
            }}
            shortcut={{ key: "m" }}
          >
            Metadata
          </TabButton>
        </TabContainer>
      </div>
      <div className="overflow-y-auto px-3 scrollbar-thin scrollbar-track-transparent scrollbar-thumb-surface-control">
        <div>
          {tab === "detail" ? (
            <div className="flex flex-col gap-4 py-3">
              <Property.Table>
                <Property.Item>
                  <Property.Label>Status</Property.Label>
                  <Property.Value>
                    {waitingView && waitingView.notStarted.cause !== "externalExpired" ? (
                      <NotStartedStatus notStarted={waitingView.notStarted} />
                    ) : (
                      <SimpleTooltip
                        button={<TaskRunStatusCombo status={run.status} />}
                        content={descriptionForTaskRunStatus(run.status)}
                        disableHoverableContent
                      />
                    )}
                  </Property.Value>
                </Property.Item>
                <Property.Item>
                  <Property.Label>Task</Property.Label>
                  <Property.Value>
                    <SimpleTooltip
                      button={
                        <TextLink
                          to={v3RunsPath(organization, project, environment, {
                            tasks: [run.taskIdentifier],
                          })}
                        >
                          <CopyableText
                            value={run.taskIdentifier}
                            copyValue={run.taskIdentifier}
                            asChild
                          />
                        </TextLink>
                      }
                      content={`View runs filtered by ${run.taskIdentifier}`}
                      disableHoverableContent
                    />
                  </Property.Value>
                </Property.Item>
                <Property.Item>
                  <Property.Label>Run ID</Property.Label>
                  <Property.Value>
                    <CopyableText value={run.friendlyId} copyValue={run.friendlyId} asChild />
                  </Property.Value>
                </Property.Item>
                {run.relationships.root ? (
                  run.relationships.root.isParent ? (
                    <Property.Item>
                      <Property.Label>Root & Parent run</Property.Label>
                      <Property.Value>
                        <SimpleTooltip
                          button={
                            <TextLink
                              to={v3RunSpanPath(
                                organization,
                                project,
                                environment,
                                {
                                  friendlyId: run.relationships.root.friendlyId,
                                },
                                { spanId: run.relationships.root.spanId }
                              )}
                              className="group flex flex-wrap items-center gap-x-1 gap-y-0"
                            >
                              <CopyableText
                                value={run.relationships.root.taskIdentifier}
                                copyValue={run.relationships.root.taskIdentifier}
                                asChild
                              />
                              <span className="break-all text-text-dimmed transition-colors group-hover:text-text-bright/80">
                                <CopyableText
                                  value={run.relationships.root.friendlyId}
                                  copyValue={run.relationships.root.friendlyId}
                                  asChild
                                />
                              </span>
                            </TextLink>
                          }
                          content={`Jump to root/parent run`}
                          disableHoverableContent
                        />
                      </Property.Value>
                    </Property.Item>
                  ) : (
                    <>
                      <Property.Item>
                        <Property.Label>Root run</Property.Label>
                        <Property.Value>
                          <SimpleTooltip
                            button={
                              <TextLink
                                to={v3RunSpanPath(
                                  organization,
                                  project,
                                  environment,
                                  {
                                    friendlyId: run.relationships.root.friendlyId,
                                  },
                                  { spanId: run.relationships.root.spanId }
                                )}
                                className="group flex flex-wrap items-center gap-x-1 gap-y-0"
                              >
                                <CopyableText
                                  value={run.relationships.root.taskIdentifier}
                                  copyValue={run.relationships.root.taskIdentifier}
                                  asChild
                                />
                                <span className="break-all text-text-dimmed transition-colors group-hover:text-text-bright/80">
                                  <CopyableText
                                    value={run.relationships.root.friendlyId}
                                    copyValue={run.relationships.root.friendlyId}
                                    asChild
                                  />
                                </span>
                              </TextLink>
                            }
                            content={`Jump to root run`}
                            disableHoverableContent
                          />
                        </Property.Value>
                      </Property.Item>
                      {run.relationships.parent ? (
                        <Property.Item>
                          <Property.Label>Parent run</Property.Label>
                          <Property.Value>
                            <SimpleTooltip
                              button={
                                <TextLink
                                  to={v3RunSpanPath(
                                    organization,
                                    project,
                                    environment,
                                    {
                                      friendlyId: run.relationships.parent.friendlyId,
                                    },
                                    { spanId: run.relationships.parent.spanId }
                                  )}
                                  className="group flex flex-wrap items-center gap-x-1 gap-y-0"
                                >
                                  <CopyableText
                                    value={run.relationships.parent.taskIdentifier}
                                    copyValue={run.relationships.parent.taskIdentifier}
                                    asChild
                                  />
                                  <span className="break-all text-text-dimmed transition-colors group-hover:text-text-bright/80">
                                    <CopyableText
                                      value={run.relationships.parent.friendlyId}
                                      copyValue={run.relationships.parent.friendlyId}
                                      asChild
                                    />
                                  </span>
                                </TextLink>
                              }
                              content={`Jump to parent run`}
                              disableHoverableContent
                            />
                          </Property.Value>
                        </Property.Item>
                      ) : null}
                    </>
                  )
                ) : null}
                <RunContinuationProperties
                  handedOverTo={handedOverTo}
                  continuedFrom={continuedFrom}
                />
                {run.batch && (
                  <Property.Item>
                    <Property.Label>Batch</Property.Label>
                    <Property.Value>
                      <SimpleTooltip
                        button={
                          <TextLink to={v3BatchPath(organization, project, environment, run.batch)}>
                            <CopyableText
                              value={run.batch.friendlyId}
                              copyValue={run.batch.friendlyId}
                              asChild
                            />
                          </TextLink>
                        }
                        content={`View batches filtered by ${run.batch.friendlyId}`}
                        disableHoverableContent
                      />
                    </Property.Value>
                  </Property.Item>
                )}
                {run.session && (
                  <RunSessionProperty session={run.session} runFriendlyId={run.friendlyId} />
                )}
                <Property.Item>
                  <Property.Label>
                    <div className="flex items-center justify-between">
                      <span className="flex items-center gap-1">
                        Idempotency
                        <InfoIconTooltip
                          content={
                            <div className="flex max-w-xs flex-col gap-3 p-1 pb-2">
                              <div>
                                <div className="mb-0.5 flex items-center gap-1.5">
                                  <KeyIcon className="size-4 text-text-dimmed" />
                                  <Header3>Idempotency keys</Header3>
                                </div>
                                <Paragraph variant="small" className="text-wrap! text-text-dimmed">
                                  Prevent duplicate task runs. If you trigger a task with the same
                                  key twice, the second request returns the original run.
                                </Paragraph>
                              </div>
                              <div>
                                <div className="mb-1 flex items-center gap-1">
                                  <GlobeLinesIcon className="size-4 text-blue-500" />
                                  <Header3>Scope</Header3>
                                </div>
                                <div className="flex flex-col gap-0.5 text-sm text-text-dimmed">
                                  <div>Global: applies across all runs</div>
                                  <div>Run: unique to a parent run</div>
                                  <div>Attempt: unique to a specific attempt</div>
                                </div>
                              </div>
                              <div>
                                <div className="mb-1 flex items-center gap-1">
                                  <SignalIcon className="size-4 text-success" />
                                  <Header3>Status</Header3>
                                </div>
                                <div className="flex flex-col gap-0.5 text-sm text-text-dimmed">
                                  <div>Active: duplicates are blocked</div>
                                  <div>Expired: the TTL has passed</div>
                                  <div>Inactive: the key was reset or cleared</div>
                                </div>
                              </div>
                              <LinkButton
                                to={docsPath("idempotency")}
                                variant="docs/small"
                                LeadingIcon={BookOpenIcon}
                              >
                                Read docs
                              </LinkButton>
                            </div>
                          }
                        />
                      </span>
                      {run.idempotencyKeyStatus === "active" ? (
                        <resetFetcher.Form
                          method="post"
                          action={v3RunIdempotencyKeyResetPath(organization, project, environment, {
                            friendlyId: run.friendlyId,
                          })}
                        >
                          <Button
                            type="submit"
                            variant="minimal/small"
                            LeadingIcon={ArrowPathIcon}
                            disabled={!canWriteRuns || resetFetcher.state === "submitting"}
                            tooltip={
                              canWriteRuns
                                ? undefined
                                : "You don't have permission to reset idempotency keys"
                            }
                          >
                            {resetFetcher.state === "submitting" ? "Resetting..." : "Reset"}
                          </Button>
                        </resetFetcher.Form>
                      ) : run.idempotencyKeyStatus === "expired" ? (
                        <span className="flex items-center gap-1 text-xs text-amber-500">
                          <ClockIcon className="size-4" />
                          Expired
                        </span>
                      ) : run.idempotencyKeyStatus === "inactive" ? (
                        <span className="text-xs text-text-dimmed">Inactive</span>
                      ) : null}
                    </div>
                  </Property.Label>
                  <Property.Value>
                    {run.idempotencyKeyStatus ? (
                      <div className="flex flex-col gap-0.5">
                        <div>
                          <span className="text-text-dimmed">Key: </span>
                          {run.idempotencyKey ? (
                            <CopyableText
                              value={run.idempotencyKey}
                              copyValue={run.idempotencyKey}
                              asChild
                              className="max-h-5"
                            />
                          ) : (
                            "–"
                          )}
                        </div>
                        <div>
                          <span className="text-text-dimmed">Scope: </span>
                          {run.idempotencyKeyScope ?? "–"}
                        </div>
                        <div>
                          <span className="text-text-dimmed">
                            {run.idempotencyKeyStatus === "expired" ? "Expired: " : "Expires: "}
                          </span>
                          {run.idempotencyKeyExpiresAt ? (
                            <DateTime date={run.idempotencyKeyExpiresAt} />
                          ) : (
                            "–"
                          )}
                        </div>
                      </div>
                    ) : (
                      "–"
                    )}
                  </Property.Value>
                </Property.Item>
                <Property.Item>
                  <Property.Label>Debounce</Property.Label>
                  <Property.Value>
                    {run.debounce ? (
                      <div>
                        <div className="break-all">Key: {run.debounce.key}</div>
                        <div>Delay: {run.debounce.delay}</div>
                      </div>
                    ) : (
                      "–"
                    )}
                  </Property.Value>
                </Property.Item>
                <Property.Item>
                  <Property.Label>Version</Property.Label>
                  <Property.Value>
                    {run.version ? (
                      <VersionLabel version={run.version} currentVersion={currentVersion} />
                    ) : (
                      <span className="flex items-center gap-1">
                        <span>Never started</span>
                        <InfoIconTooltip
                          content={"Runs get locked to the current version when they start."}
                          contentClassName="normal-case tracking-normal"
                        />
                      </span>
                    )}
                  </Property.Value>
                </Property.Item>
                <Property.Item>
                  <Property.Label>External deployment ID</Property.Label>
                  <Property.Value>
                    <ExternalDeploymentIdValue externalDeploymentId={run.externalDeploymentId} />
                  </Property.Value>
                </Property.Item>
                <Property.Item>
                  <Property.Label>SDK version</Property.Label>
                  <Property.Value>
                    {run.sdkVersion ? (
                      run.sdkVersion
                    ) : (
                      <span className="flex items-center gap-1">
                        <span>Never started</span>
                        <InfoIconTooltip
                          content={"Runs get locked to the current version when they start."}
                          contentClassName="normal-case tracking-normal"
                        />
                      </span>
                    )}
                  </Property.Value>
                </Property.Item>
                {run.executionPolicy && (
                  <ExecutionPolicyProperties
                    policy={run.executionPolicy}
                    isDevelopment={environment.type === "DEVELOPMENT"}
                  />
                )}
                <Property.Item>
                  <Property.Label>Runtime</Property.Label>
                  <Property.Value>
                    <RuntimeIcon
                      runtime={run.runtime}
                      runtimeVersion={run.runtimeVersion}
                      withLabel
                    />
                  </Property.Value>
                </Property.Item>
                <Property.Item>
                  <Property.Label>Test run</Property.Label>
                  <Property.Value>
                    {run.isTest ? <CheckIcon className="size-4 text-text-dimmed" /> : "–"}
                  </Property.Value>
                </Property.Item>
                {run.replayedFromTaskRunFriendlyId && (
                  <Property.Item>
                    <Property.Label>Replayed from</Property.Label>
                    <Property.Value>
                      <SimpleTooltip
                        button={
                          <TextLink
                            to={v3RunRedirectPath(organization, project, {
                              friendlyId: run.replayedFromTaskRunFriendlyId,
                            })}
                          >
                            <CopyableText
                              value={run.replayedFromTaskRunFriendlyId}
                              copyValue={run.replayedFromTaskRunFriendlyId}
                              asChild
                            />
                          </TextLink>
                        }
                        content={`Jump to replayed run`}
                        disableHoverableContent
                      />
                    </Property.Value>
                  </Property.Item>
                )}
                {environment && (
                  <Property.Item>
                    <Property.Label>Environment</Property.Label>
                    <Property.Value>
                      <EnvironmentCombo environment={environment} />
                    </Property.Value>
                  </Property.Item>
                )}

                {run.schedule && (
                  <Property.Item>
                    <Property.Label>Schedule</Property.Label>
                    <Property.Value>
                      <div>
                        <div className="flex items-center gap-1">
                          <span className="font-mono">{run.schedule.generatorExpression}</span>
                          <span>({run.schedule.timezone})</span>
                        </div>
                        <SimpleTooltip
                          button={
                            <TextLink
                              to={v3ScheduledTaskSchedulePath(
                                organization,
                                project,
                                environment,
                                run.taskIdentifier,
                                run.schedule
                              )}
                            >
                              {run.schedule.description}
                            </TextLink>
                          }
                          content={`Go to schedule ${run.schedule.friendlyId}`}
                        />
                      </div>
                    </Property.Value>
                  </Property.Item>
                )}
                {run.webhook?.endpoint && (
                  <Property.Item>
                    <Property.Label>Webhook endpoint</Property.Label>
                    <Property.Value>
                      <TextLink
                        to={v3WebhookEndpointPath(
                          organization,
                          project,
                          environment,
                          run.webhook.endpoint.friendlyId
                        )}
                      >
                        {run.webhook.endpoint.declaredId}
                        {run.webhook.endpoint.tenantId ? ` · ${run.webhook.endpoint.tenantId}` : ""}
                      </TextLink>
                    </Property.Value>
                  </Property.Item>
                )}
                {run.webhook && (
                  <Property.Item>
                    <Property.Label>Webhook delivery</Property.Label>
                    <Property.Value>
                      <TextLink
                        to={v3WebhookDeliveryPath(
                          organization,
                          project,
                          environment,
                          run.webhook.deliveryFriendlyId
                        )}
                        className="font-mono"
                      >
                        {run.webhook.deliveryFriendlyId}
                      </TextLink>
                    </Property.Value>
                  </Property.Item>
                )}
                <Property.Item>
                  <Property.Label>Queue</Property.Label>
                  <Property.Value>
                    <div>
                      Name:{" "}
                      {queuePath ? (
                        <TextLink to={queuePath}>{run.queue.name}</TextLink>
                      ) : (
                        run.queue.name
                      )}
                    </div>
                    <div>
                      Concurrency key:{" "}
                      {run.queue.concurrencyKey ? (
                        queuePath ? (
                          <TextLink
                            to={`${queuePath}?view=keys&key=${encodeURIComponent(
                              run.queue.concurrencyKey
                            )}`}
                          >
                            {run.queue.concurrencyKey}
                          </TextLink>
                        ) : (
                          run.queue.concurrencyKey
                        )
                      ) : (
                        "–"
                      )}
                    </div>
                  </Property.Value>
                </Property.Item>
                <Property.Item>
                  <Property.Label>Time to live (TTL)</Property.Label>
                  <Property.Value>{run.ttl ?? "–"}</Property.Value>
                </Property.Item>
                <Property.Item>
                  <Property.Label>Tags</Property.Label>
                  <Property.Value>
                    {run.tags.length === 0 ? (
                      "–"
                    ) : (
                      <div className="mt-1 flex flex-wrap items-center gap-1 text-xs">
                        {run.tags.map((tag: string) => (
                          <RunTag
                            key={tag}
                            tag={tag}
                            to={v3RunsPath(organization, project, environment, { tags: [tag] })}
                            tooltip={`Filter runs by ${tag}`}
                          />
                        ))}
                      </div>
                    )}
                  </Property.Value>
                </Property.Item>
                <Property.Item>
                  <Property.Label>Max duration</Property.Label>
                  <Property.Value>
                    {run.maxDurationInSeconds
                      ? `${run.maxDurationInSeconds}s (${formatDurationMilliseconds(
                          run.maxDurationInSeconds * 1000,
                          { style: "short" }
                        )})`
                      : "–"}
                  </Property.Value>
                </Property.Item>
                <Property.Item>
                  <Property.Label>
                    <span className="flex items-center gap-1">
                      Machine
                      <InfoIconTooltip content={<MachineTooltipInfo />} />
                    </span>
                  </Property.Label>
                  <Property.Value className="-ml-0.5">
                    <MachineLabelCombo preset={run.machinePreset} />
                  </Property.Value>
                </Property.Item>
                {run.region && (
                  <Property.Item>
                    <Property.Label>Region</Property.Label>
                    <Property.Value>
                      <RegionLabel region={run.region} />
                    </Property.Value>
                  </Property.Item>
                )}
                <Property.Item>
                  <Property.Label>Run invocation cost</Property.Label>
                  <Property.Value>
                    {run.baseCostInCents > 0
                      ? formatCurrencyAccurate(run.baseCostInCents / 100)
                      : "–"}
                  </Property.Value>
                </Property.Item>
                <Property.Item>
                  <Property.Label>Compute cost</Property.Label>
                  <Property.Value>
                    {run.costInCents > 0 ? formatCurrencyAccurate(run.costInCents / 100) : "–"}
                  </Property.Value>
                </Property.Item>
                <Property.Item>
                  <Property.Label>Total cost</Property.Label>
                  <Property.Value>
                    {run.costInCents > 0
                      ? formatCurrencyAccurate((run.baseCostInCents + run.costInCents) / 100)
                      : "–"}
                  </Property.Value>
                </Property.Item>
                <Property.Item>
                  <Property.Label>Usage duration</Property.Label>
                  <Property.Value>
                    {run.usageDurationMs > 0
                      ? formatDurationMilliseconds(run.usageDurationMs, { style: "short" })
                      : "–"}
                  </Property.Value>
                </Property.Item>
                <Property.Item>
                  <Property.Label>Run Engine</Property.Label>
                  <Property.Value>{run.engine}</Property.Value>
                </Property.Item>
                {run.externalTraceId && (
                  <Property.Item>
                    <Property.Label>External Trace ID</Property.Label>
                    <Property.Value>{run.externalTraceId}</Property.Value>
                  </Property.Item>
                )}
                {isAdmin && (
                  <div className="border-t border-yellow-500/50 pt-2">
                    <Paragraph spacing variant="small" className="text-yellow-500">
                      Admin only
                    </Paragraph>
                    <Property.Item>
                      <Property.Label>Buffered</Property.Label>
                      <Property.Value>{run.isBuffered ? "Yes" : "No"}</Property.Value>
                    </Property.Item>
                    <Property.Item>
                      <Property.Label>Worker queue</Property.Label>
                      <Property.Value>{run.workerQueue}</Property.Value>
                    </Property.Item>
                    <Property.Item>
                      <Property.Label>Worker cell</Property.Label>
                      <Property.Value>{run.workerCell ?? "–"}</Property.Value>
                    </Property.Item>
                    <Property.Item>
                      <Property.Label>Worker lane</Property.Label>
                      <Property.Value>{run.workerLane ?? "–"}</Property.Value>
                    </Property.Item>
                    <Property.Item>
                      <Property.Label>Trace ID</Property.Label>
                      <Property.Value>{run.traceId}</Property.Value>
                    </Property.Item>
                    <Property.Item>
                      <Property.Label>Span ID</Property.Label>
                      <Property.Value>{run.spanId}</Property.Value>
                    </Property.Item>
                    <Property.Item>
                      <Property.Label>Task event store</Property.Label>
                      <Property.Value>{run.taskEventStore}</Property.Value>
                    </Property.Item>
                  </div>
                )}
              </Property.Table>
            </div>
          ) : tab === "context" ? (
            <div className="flex flex-col gap-4 py-3">
              <CodeBlock code={run.context} showLineNumbers={false} showTextWrapping />
            </div>
          ) : tab === "metadata" ? (
            <div className="flex flex-col gap-4 py-3">
              {run.metadata ? (
                <CodeBlock code={run.metadata} showLineNumbers={false} showTextWrapping />
              ) : (
                <Callout to="https://trigger.dev/docs/runs/metadata" variant="docs">
                  No metadata set for this run. View our metadata documentation to learn more.
                </Callout>
              )}
            </div>
          ) : (
            <div className="flex flex-col gap-4 pt-3">
              {/* A run that hasn't started shows why in place of its status. */}
              {waitingView ? (
                <NotStartedCard initial={waitingView} runFriendlyId={run.friendlyId} />
              ) : (
                <div
                  className={cn(
                    "border-b border-grid-bright pb-3",
                    statusAccessory && "flex items-center justify-between gap-2"
                  )}
                >
                  <SimpleTooltip
                    button={<TaskRunStatusCombo status={run.status} className="text-sm" />}
                    content={descriptionForTaskRunStatus(run.status)}
                  />
                  {statusAccessory}
                </div>
              )}
              <RunTimeline run={run} />

              {/* Offer Investigate for runs that are actively in progress. Failed runs get
                  their own prompt below, and runs that haven't started have one with their
                  status. */}
              {isInProgressRunStatus(run.status) ? (
                <InvestigateButton
                  prompt={runningRunPrompt(run.friendlyId)}
                  className="self-start"
                />
              ) : null}

              {run.error && (
                <div className="flex flex-col gap-2">
                  <RunError error={run.error} status={run.status} />
                  {isFailedRunStatus(run.status) ? (
                    <InvestigateButton
                      prompt={failedRunPrompt(run.friendlyId)}
                      className="self-start"
                    />
                  ) : null}
                </div>
              )}

              {run.payload !== undefined && (
                <PacketDisplay data={run.payload} dataType={run.payloadType} title="Payload" />
              )}

              {run.error === undefined && run.output !== undefined ? (
                <PacketDisplay data={run.output} dataType={run.outputType} title="Output" />
              ) : null}
            </div>
          )}
        </div>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-grid-dimmed px-2 py-2">
        <div className="flex items-center gap-4">
          {run.friendlyId !== runParam && !hideFocusOnRun && (
            <LinkButton
              to={v3RunSpanPath(
                organization,
                project,
                environment,
                { friendlyId: run.friendlyId },
                { spanId: run.spanId }
              )}
              variant="minimal/medium"
              LeadingIcon={QueueListIcon}
              shortcut={{ key: "f" }}
            >
              {run.isCached ? "Jump to original run" : "Focus on run"}
            </LinkButton>
          )}
          {!run.isBuffered && <AdminDebugRun friendlyId={run.friendlyId} />}
        </div>
        <div className="flex items-center">
          {run.logsDeletedAt === null ? (
            <Popover>
              <PopoverTrigger asChild>
                <Button
                  variant="secondary/medium"
                  LeadingIcon={CloudArrowDownIcon}
                  leadingIconClassName="text-indigo-400"
                  TrailingIcon={ChevronUpIcon}
                >
                  Export trace
                </Button>
              </PopoverTrigger>
              <PopoverContent className="min-w-[180px] p-1" align="end">
                <TraceExportMenuItems runParam={runParam} />
              </PopoverContent>
            </Popover>
          ) : null}
        </div>
      </div>
    </div>
  );
}

const EXTERNAL_DEPLOYMENT_ID_DISPLAY_LENGTH = 24;

function ExecutionPolicyProperties({
  policy,
  isDevelopment,
}: {
  policy: RunExecutionPolicy;
  isDevelopment: boolean;
}) {
  return (
    <>
      <Property.Item>
        <Property.Label>Sandbox</Property.Label>
        <Property.Value>
          {isDevelopment
            ? "Not enforced in development: runs locally with your dev environment's credentials"
            : `Runs on a microVM${policy.rootKey ? "" : " without the environment secret key"}`}
        </Property.Value>
      </Property.Item>
      <Property.Item>
        <Property.Label>Run token scopes</Property.Label>
        <Property.Value className="font-mono text-xs">{policy.scopes.join(", ")}</Property.Value>
      </Property.Item>
      <Property.Item>
        <Property.Label>Environment variables</Property.Label>
        <Property.Value>
          {policy.envVars === "all"
            ? "All"
            : policy.envVars.length === 0
              ? "None"
              : policy.envVars.join(", ")}
        </Property.Value>
      </Property.Item>
    </>
  );
}

function ExternalDeploymentIdValue({
  externalDeploymentId,
}: {
  externalDeploymentId: string | undefined;
}) {
  if (!externalDeploymentId) {
    return <>–</>;
  }

  const display =
    externalDeploymentId.length > EXTERNAL_DEPLOYMENT_ID_DISPLAY_LENGTH
      ? `${externalDeploymentId.slice(0, EXTERNAL_DEPLOYMENT_ID_DISPLAY_LENGTH)}…`
      : externalDeploymentId;

  return (
    <CopyableText value={display} copyValue={externalDeploymentId} className="font-mono" asChild />
  );
}

function TraceExportMenuItems({ runParam }: { runParam: string }) {
  const downloadPath = v3RunDownloadLogsPath({ friendlyId: runParam });

  const copyForAI = async () => {
    try {
      // Hand the clipboard a ClipboardItem backed by a promise so access is
      // reserved synchronously during the click. The fetch can then take as long
      // as a large trace needs without the browser revoking the transient user
      // activation, which a fetch-then-writeText sequence trips (notably Safari
      // and Firefox).
      const text = fetch(`${downloadPath}?format=markdown`, { credentials: "include" }).then(
        async (response) => {
          if (!response.ok) {
            throw new Error(`Request failed with ${response.status}`);
          }
          return new Blob([await response.text()], { type: "text/plain" });
        }
      );

      await navigator.clipboard.write([new ClipboardItem({ "text/plain": text })]);
      toast.custom((t) => (
        <ToastUI variant="success" message="Copied trace as Markdown" t={t as string} />
      ));
    } catch {
      toast.custom((t) => (
        <ToastUI variant="error" message="Couldn't copy the trace" t={t as string} />
      ));
    }
  };

  return (
    <>
      <PopoverMenuItem
        title="Copy for AI"
        icon={ClipboardDocumentIcon}
        leadingIconClassName="text-emerald-500"
        onClick={copyForAI}
      />
      <PopoverMenuItem
        to={`${downloadPath}?format=markdown`}
        title="Download · Markdown"
        icon={CloudArrowDownIcon}
        leadingIconClassName="text-indigo-500"
        openInNewTab
      />
      <PopoverMenuItem
        to={`${downloadPath}?format=log`}
        title="Download · Log"
        icon={CloudArrowDownIcon}
        leadingIconClassName="text-indigo-500"
        openInNewTab
      />
      <PopoverMenuItem
        to={`${downloadPath}?format=jsonl`}
        title="Download · JSON Lines"
        icon={CloudArrowDownIcon}
        leadingIconClassName="text-indigo-500"
        openInNewTab
      />
    </>
  );
}

function RunSessionProperty({
  session,
  runFriendlyId,
}: {
  session: { friendlyId: string; externalId: string | null; status: SessionStatus; reason: string };
  runFriendlyId: string;
}) {
  const organization = useOrganization();
  const project = useProject();
  const environment = useEnvironment();
  // On this session's own page a link would only reload it and drop the selection.
  const { sessionParam } = useParams();
  const onSessionPage = sessionParam === session.friendlyId || sessionParam === session.externalId;

  const id = (
    <CopyableText
      value={session.externalId ?? session.friendlyId}
      copyValue={session.externalId ?? session.friendlyId}
      asChild
    />
  );
  const status = <SessionStatusCombo status={session.status} />;

  return (
    <Property.Item>
      <Property.Label>Session</Property.Label>
      <Property.Value>
        {onSessionPage ? (
          <span className="flex flex-wrap items-center gap-x-2 gap-y-0">
            {id}
            {status}
          </span>
        ) : (
          <SimpleTooltip
            button={
              <TextLink
                to={`${v3SessionPath(organization, project, environment, session)}?${SESSION_RUN_PARAM}=${runFriendlyId}`}
                className="group flex flex-wrap items-center gap-x-2 gap-y-0"
              >
                {id}
                {status}
              </TextLink>
            }
            content={`Jump to session (${session.reason})`}
            disableHoverableContent
          />
        )}
      </Property.Value>
    </Property.Item>
  );
}

function StartedSessionProperty({ session }: { session: StartedSession }) {
  const organization = useOrganization();
  const project = useProject();
  const environment = useEnvironment();

  const id = <CopyableText value={session.externalId} copyValue={session.externalId} asChild />;
  const status = <SessionStatusCombo status={session.status} />;

  return (
    <Property.Item>
      <Property.Label>Started session</Property.Label>
      <Property.Value>
        {session.isCurrent ? (
          <span className="flex flex-wrap items-center gap-x-2 gap-y-0">
            {id}
            {status}
          </span>
        ) : (
          <SimpleTooltip
            button={
              <TextLink
                to={v3SessionPath(organization, project, environment, {
                  friendlyId: session.friendlyId,
                })}
                className="group flex flex-wrap items-center gap-x-2 gap-y-0"
              >
                {id}
                {status}
              </TextLink>
            }
            content="Jump to session"
            disableHoverableContent
          />
        )}
      </Property.Value>
    </Property.Item>
  );
}

function SpanEntity({ span, statusAccessory }: { span: Span; statusAccessory?: React.ReactNode }) {
  const docsLink = useDocsLink();
  const isAdmin = useHasAdminAccess();

  const organization = useOrganization();
  const project = useProject();
  const environment = useEnvironment();

  if (!span.entity) {
    //normal span
    return (
      <div className="flex flex-col gap-4 p-3">
        {span.level === "TRACE" ? (
          <>
            <div
              className={cn(
                "border-b border-grid-bright pb-3",
                statusAccessory && "flex items-center justify-between gap-2"
              )}
            >
              <TaskRunAttemptStatusCombo
                status={
                  span.isCancelled
                    ? "CANCELED"
                    : span.isError
                      ? "FAILED"
                      : span.isPartial
                        ? "EXECUTING"
                        : "COMPLETED"
                }
                className="text-sm"
              />
              {statusAccessory}
            </div>
            <SpanTimeline
              startTime={new Date(span.startTime)}
              duration={span.duration}
              inProgress={span.isPartial}
              isError={span.isError}
              events={createTimelineSpanEventsFromSpanEvents(span.events, isAdmin)}
            />
          </>
        ) : (
          <div className="min-w-fit max-w-80">
            <RunTimelineEvent
              title="Timestamp"
              subtitle={<DateTimeAccurate date={span.startTime} />}
              variant="dot-solid"
            />
          </div>
        )}
        <Property.Table>
          {span.startedSession && <StartedSessionProperty session={span.startedSession} />}
          <Property.Item>
            <Property.Label className="flex items-center justify-between">
              <span>Message</span>
              <CopyTextLink value={span.message} />
            </Property.Label>
            <Property.Value className="whitespace-pre-wrap wrap-break-word">
              {span.message}
            </Property.Value>
          </Property.Item>
        </Property.Table>
        {span.events.length > 0 && <SpanEvents spanEvents={span.events} />}
        {span.properties !== undefined ? (
          <CodeBlock
            rowTitle="Properties"
            code={span.properties}
            maxLines={20}
            showLineNumbers={false}
            showCopyButton
            showTextWrapping
            showOpenInModal
          />
        ) : null}
        {span.resourceProperties !== undefined ? (
          <CodeBlock
            rowTitle="Resource properties"
            code={span.resourceProperties}
            maxLines={20}
            showLineNumbers={false}
            showCopyButton
            showTextWrapping
            showOpenInModal
          />
        ) : null}
        {span.triggeredRuns.length > 0 && (
          <div className="flex flex-col gap-1.5">
            <Header3>Runs</Header3>
            <Table containerClassName="max-h-50">
              <TableHeader className="bg-background-bright">
                <TableRow>
                  <TableHeaderCell>ID</TableHeaderCell>
                  <TableHeaderCell>Task</TableHeaderCell>
                  <TableHeaderCell>Status</TableHeaderCell>
                  <TableHeaderCell>Created</TableHeaderCell>
                </TableRow>
              </TableHeader>
              <TableBody>
                {span.triggeredRuns.map((run) => {
                  const path = v3RunSpanPath(
                    organization,
                    project,
                    environment,
                    { friendlyId: run.friendlyId },
                    { spanId: run.spanId }
                  );
                  return (
                    <TableRow key={run.friendlyId}>
                      <TableCell to={path} actionClassName="py-1.5" rowHoverStyle="bright">
                        <TruncatedCopyableValue value={run.friendlyId} />
                      </TableCell>
                      <TableCell to={path} actionClassName="py-1.5" rowHoverStyle="bright">
                        {run.taskIdentifier}
                      </TableCell>
                      <TableCell to={path} actionClassName="py-1.5" rowHoverStyle="bright">
                        <TaskRunStatusCombo status={run.status} />
                      </TableCell>
                      <TableCell to={path} actionClassName="py-1.5" rowHoverStyle="bright">
                        <DateTimeAccurate date={run.createdAt} hour12={false} hideDate={true} />
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}
      </div>
    );
  }

  switch (span.entity.type) {
    case "attempt": {
      return (
        <div className="flex flex-col gap-4 p-3">
          <div className="border-b border-grid-bright pb-3">
            <TaskRunAttemptStatusCombo
              status={
                span.isCancelled
                  ? "CANCELED"
                  : span.isError
                    ? "FAILED"
                    : span.isPartial
                      ? "EXECUTING"
                      : "COMPLETED"
              }
              className="text-sm"
            />
          </div>
          <SpanTimeline
            startTime={new Date(span.startTime)}
            duration={span.duration}
            inProgress={span.isPartial}
            isError={span.isError}
            events={createTimelineSpanEventsFromSpanEvents(span.events, isAdmin)}
          />
          {span.entity.object.isWarmStart !== undefined ? (
            <WarmStartCombo
              isWarmStart={span.entity.object.isWarmStart}
              showTooltip
              className="my-3"
            />
          ) : null}
          {span.events.length > 0 && <SpanEvents spanEvents={span.events} />}
          {span.properties !== undefined ? (
            <CodeBlock
              rowTitle="Properties"
              code={span.properties}
              maxLines={20}
              showLineNumbers={false}
              showCopyButton
              showTextWrapping
              showOpenInModal
            />
          ) : null}
        </div>
      );
    }
    case "waitpoint": {
      return (
        <div className="grid h-full grid-rows-[1fr_auto]">
          <div className="flex flex-col gap-4 overflow-y-auto px-3 pt-3 scrollbar-thin scrollbar-track-transparent scrollbar-thumb-surface-control">
            <div>
              <Header2>Waitpoint</Header2>
              <Paragraph variant="small">
                A waitpoint pauses your code from continuing until the conditions are met.{" "}
                <TextLink {...docsLink("wait")}>View docs</TextLink>.
              </Paragraph>
            </div>
            <WaitpointDetailTable waitpoint={span.entity.object} linkToList />
          </div>
          {span.entity.object.status === "WAITING" && (
            <div>
              <CompleteWaitpointForm waitpoint={span.entity.object} />
            </div>
          )}
        </div>
      );
    }
    case "realtime-stream": {
      return (
        <RealtimeStreamViewer
          runId={span.entity.object.runId}
          streamKey={span.entity.object.streamKey}
          metadata={span.entity.object.metadata}
          displayName={span.entity.object.displayName}
        />
      );
    }
    case "session-stream": {
      const { sessionId, channel, io } = span.entity.object;
      const base = `/resources/orgs/${organization.slug}/projects/${project.slug}/env/${environment.slug}/sessions/${encodeURIComponent(sessionId)}/realtime/v1`;
      const resourcePath = channel
        ? `${base}/channels/${encodeURIComponent(channel)}/${io}`
        : `${base}/${io}`;
      const displayName = channel ? `${channel}.${io}` : `${sessionId}.${io}`;
      return (
        <RealtimeStreamViewer
          resourcePath={resourcePath}
          headerLabel={channel ? "Channel:" : "Session:"}
          displayName={displayName}
        />
      );
    }
    case "ai-generation":
    case "ai-summary": {
      return (
        <AISpanDetails
          aiData={span.entity.object}
          promptVersionData={span.entity.promptVersionData}
          rawProperties={
            typeof span.properties === "string"
              ? span.properties
              : span.properties != null
                ? JSON.stringify(span.properties, null, 2)
                : undefined
          }
          startTime={span.startTime}
          duration={span.duration}
        />
      );
    }
    case "ai-tool-call": {
      return (
        <div className="overflow-y-auto scrollbar-thin scrollbar-track-transparent scrollbar-thumb-surface-control">
          <div className="px-3">
            <SpanHorizontalTimeline startTime={span.startTime} duration={span.duration} />
          </div>
          <AIToolCallSpanDetails data={span.entity.object} spanEvents={span.events} />
        </div>
      );
    }
    case "ai-embed": {
      return (
        <div className="overflow-y-auto scrollbar-thin scrollbar-track-transparent scrollbar-thumb-surface-control">
          <div className="px-3">
            <SpanHorizontalTimeline startTime={span.startTime} duration={span.duration} />
          </div>
          <AIEmbedSpanDetails data={span.entity.object} spanEvents={span.events} />
        </div>
      );
    }
    case "prompt": {
      return (
        <PromptSpanDetails
          promptData={span.entity.object}
          startTime={span.startTime}
          duration={span.duration}
        />
      );
    }
    default: {
      assertNever(span.entity);
    }
  }
}
