import { GlobeLinesIcon } from "~/assets/icons/GlobeLinesIcon";
import {
  ArrowPathIcon,
  BookOpenIcon,
  CheckIcon,
  ChevronUpIcon,
  ClipboardDocumentIcon,
  ClockIcon,
  CloudArrowDownIcon,
  EnvelopeIcon,
  ExclamationTriangleIcon,
  KeyIcon,
  QueueListIcon,
  SignalIcon,
} from "@heroicons/react/20/solid";
import { type LoaderFunctionArgs } from "@remix-run/server-runtime";
import {
  formatDurationMilliseconds,
  type TaskRunError,
  taskRunErrorEnhancer,
} from "@trigger.dev/core/v3";
import { assertNever } from "assert-never";
import { type ReactNode, useEffect } from "react";
import { typedjson, useTypedFetcher } from "remix-typedjson";
import { toast } from "sonner";
import { ExitIcon } from "~/assets/icons/ExitIcon";
import { QueuesIcon } from "~/assets/icons/QueuesIcon";
import { AdminDebugRun } from "~/components/admin/debugRun";
import { CodeBlock } from "~/components/code/CodeBlock";
import { EnvironmentCombo } from "~/components/environments/EnvironmentLabel";
import { Feedback } from "~/components/Feedback";
import { MachineLabelCombo } from "~/components/MachineLabelCombo";
import { MachineTooltipInfo } from "~/components/MachineTooltipInfo";
import { Button, LinkButton } from "~/components/primitives/Buttons";
import { InvestigateButton } from "~/components/dashboard-agent/InvestigateButton";
import { WatchButton } from "~/components/dashboard-agent/WatchButton";
import { isFinalRunStatus } from "~/v3/taskStatus";
import { runWatchRecommendation } from "~/components/dashboard-agent/watch-recommendations";
import {
  failedRunPrompt,
  isFailedRunStatus,
  waitingRunPrompt,
} from "~/components/dashboard-agent/investigate-prompts";
import { Callout } from "~/components/primitives/Callout";
import { CopyableText } from "~/components/primitives/CopyableText";
import { CopyTextLink } from "~/components/primitives/CopyTextLink";
import { DateTime, DateTimeAccurate } from "~/components/primitives/DateTime";
import { Header2, Header3 } from "~/components/primitives/Headers";
import { Paragraph } from "~/components/primitives/Paragraph";
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
import { WarmStartCombo } from "~/components/WarmStarts";
import { useEnvironment } from "~/hooks/useEnvironment";
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
import { useSearchParams } from "~/hooks/useSearchParam";
import { useIsMetricResponseFresh } from "~/hooks/useMetricResourceQuery";
import { useHasAdminAccess } from "~/hooks/useUser";
import { redirectWithErrorMessage } from "~/models/message.server";
import {
  clickhouseTimeToMs,
  formatWaitMs,
  QueueMetricChart,
  QUEUE_METRIC_COLORS,
  toNumber,
  useQueueMetric,
} from "~/components/queues/QueueMetricCards";
import {
  resolveRunQueueMetrics,
  type RunQueueMetrics,
  type RunQueueWaiting,
} from "~/presenters/v3/RunQueueMetricsPresenter.server";
import { type Span, SpanPresenter, type SpanRun } from "~/presenters/v3/SpanPresenter.server";
import { logger } from "~/services/logger.server";
import { requireUserId } from "~/services/session.server";
import { cn } from "~/utils/cn";
import { formatCurrencyAccurate } from "~/utils/numberFormatter";
import {
  docsPath,
  v3BatchPath,
  v3DeploymentVersionPath,
  v3QueuePath,
  v3RunDownloadLogsPath,
  v3RunIdempotencyKeyResetPath,
  v3RunPath,
  v3RunRedirectPath,
  v3RunSpanPath,
  v3RunsPath,
  v3SchedulePath,
  v3SessionPath,
  v3SpanParamsSchema,
} from "~/utils/pathBuilder";
import { createTimelineSpanEventsFromSpanEvents } from "~/utils/timelineSpanEvents";
import type { SpanOverride } from "~/v3/eventRepository/eventRepository.types";
import { type action as resetIdempotencyKeyAction } from "../resources.orgs.$organizationSlug.projects.$projectParam.env.$envParam.runs.$runParam.idempotencyKey.reset";
import { RealtimeStreamViewer } from "../resources.orgs.$organizationSlug.projects.$projectParam.env.$envParam.runs.$runParam.streams.$streamKey/route";
import { CompleteWaitpointForm } from "../resources.orgs.$organizationSlug.projects.$projectParam.env.$envParam.waitpoints.$waitpointFriendlyId.complete/route";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const userId = await requireUserId(request);
  const { projectParam, organizationSlug, envParam, runParam, spanParam } =
    v3SpanParamsSchema.parse(params);

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
      return typedjson({
        type: "run" as const,
        run: result.run,
        queueMetrics,
        loadedAt: Date.now(),
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
}: {
  runParam: string;
  spanId: string | undefined;
  spanOverrides?: SpanOverride;
  closePanel?: () => void;
  linkedRunId?: string;
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
  }, [organization.slug, project.slug, environment.slug, runParam, spanId, linkedRunId, load]);

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
          loadedAt={fetcher.data.loadedAt}
          runParam={runParam}
          spanId={spanId}
          closePanel={closePanel}
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
}: {
  span: Span;
  spanOverrides?: SpanOverride;
  runParam?: string;
  closePanel?: () => void;
}) {
  const _organization = useOrganization();
  const _project = useProject();
  const _environment = useEnvironment();
  const { value, replace: _replace } = useSearchParams();
  let tab = value("tab");

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
          {runParam && closePanel && (
            <Button
              onClick={closePanel}
              variant="minimal/small"
              TrailingIcon={ExitIcon}
              shortcut={{ key: "esc" }}
              shortcutPosition="before-trailing-icon"
              className="pl-1"
            />
          )}
        </div>
      </div>
      {isAiInspector ? (
        <SpanEntity span={span} />
      ) : (
        <div className="scrollbar-gutter-stable overflow-y-auto scrollbar-thin scrollbar-track-transparent scrollbar-thumb-surface-control">
          <SpanEntity span={span} />
        </div>
      )}
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
  loadedAt,
  runParam,
  spanId,
  closePanel,
}: {
  run: SpanRun;
  queueMetrics: RunQueueMetrics | null;
  loadedAt: number;
  runParam: string;
  spanId: string;
  closePanel?: () => void;
}) {
  const organization = useOrganization();
  const project = useProject();
  const environment = useEnvironment();
  const isAdmin = useHasAdminAccess();
  const { value, replace } = useSearchParams();
  const tab = value("tab");
  const resetFetcher = useTypedFetcher<typeof resetIdempotencyKeyAction>();

  const queuePath = queueMetrics?.queueFriendlyId
    ? v3QueuePath(organization, project, environment, {
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
              run.isAgentRun ? "text-agents" : run.isScheduled ? "text-schedules" : "text-blue-500",
              // System themes: monochrome title, the task icon keeps the color
              "system:text-text-bright"
            )}
          >
            <span className="truncate">
              {run.taskIdentifier}
              {run.isCached ? " (cached)" : null}
            </span>
          </Header2>
        </div>
        {runParam && closePanel && (
          <Button
            onClick={closePanel}
            variant="minimal/small"
            TrailingIcon={ExitIcon}
            shortcut={{ key: "esc" }}
            shortcutPosition="before-trailing-icon"
            className="pl-1"
          />
        )}
      </div>
      <div className="h-fit overflow-x-auto px-3 scrollbar-thin scrollbar-track-transparent scrollbar-thumb-surface-control">
        <TabContainer>
          <TabButton
            isActive={!tab || tab === "overview"}
            layoutId="span-run"
            onClick={() => {
              replace({ tab: "overview" });
            }}
            shortcut={{ key: "o" }}
          >
            Overview
          </TabButton>
          <TabButton
            isActive={tab === "detail"}
            layoutId="span-run"
            onClick={() => {
              replace({ tab: "detail" });
            }}
            shortcut={{ key: "d" }}
          >
            Detail
          </TabButton>
          <TabButton
            isActive={tab === "context"}
            layoutId="span-run"
            onClick={() => {
              replace({ tab: "context" });
            }}
            shortcut={{ key: "x" }}
          >
            Context
          </TabButton>

          <TabButton
            isActive={tab === "metadata"}
            layoutId="span-run"
            onClick={() => {
              replace({ tab: "metadata" });
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
                    <SimpleTooltip
                      button={<TaskRunStatusCombo status={run.status} />}
                      content={descriptionForTaskRunStatus(run.status)}
                      disableHoverableContent
                    />
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
                  <Property.Item>
                    <Property.Label>Session</Property.Label>
                    <Property.Value>
                      <SimpleTooltip
                        button={
                          <TextLink
                            to={v3SessionPath(organization, project, environment, {
                              friendlyId: run.session.friendlyId,
                            })}
                            className="group flex flex-wrap items-center gap-x-2 gap-y-0"
                          >
                            <CopyableText
                              value={run.session.externalId ?? run.session.friendlyId}
                              copyValue={run.session.externalId ?? run.session.friendlyId}
                              asChild
                            />
                            <SessionStatusCombo status={run.session.status} />
                          </TextLink>
                        }
                        content={`Jump to session (${run.session.reason})`}
                        disableHoverableContent
                      />
                    </Property.Value>
                  </Property.Item>
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
                            disabled={resetFetcher.state === "submitting"}
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
                      environment.type === "DEVELOPMENT" ? (
                        <CopyableText value={run.version} copyValue={run.version} asChild />
                      ) : (
                        <SimpleTooltip
                          button={
                            <TextLink
                              to={v3DeploymentVersionPath(
                                organization,
                                project,
                                environment,
                                run.version
                              )}
                              className="group flex flex-wrap items-center gap-x-1 gap-y-0"
                            >
                              <CopyableText value={run.version} copyValue={run.version} asChild />
                            </TextLink>
                          }
                          content={"Jump to deployment"}
                        />
                      )
                    ) : (
                      <span className="flex items-center gap-1">
                        <span>Never started</span>
                        <InfoIconTooltip
                          content={"Runs get locked to the latest version when they start."}
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
                          content={"Runs get locked to the latest version when they start."}
                          contentClassName="normal-case tracking-normal"
                        />
                      </span>
                    )}
                  </Property.Value>
                </Property.Item>
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
                              to={v3SchedulePath(organization, project, environment, run.schedule)}
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
              {/* The waiting-queue block carries its own Status tile, so drop the duplicate
                  status combo here; other runs still get it. */}
              {queueMetrics?.waiting ? null : (
                <div className="border-b border-grid-bright pb-3">
                  <SimpleTooltip
                    button={<TaskRunStatusCombo status={run.status} className="text-sm" />}
                    content={descriptionForTaskRunStatus(run.status)}
                  />
                </div>
              )}
              {queueMetrics?.waiting ? (
                <WaitingInQueueBlock
                  queueName={queueMetrics.queueName}
                  queuePath={queuePath}
                  paused={queueMetrics.paused}
                  waiting={queueMetrics.waiting}
                  status={run.status}
                  createdAt={run.createdAt}
                  loadedAt={loadedAt}
                  runFriendlyId={run.friendlyId}
                />
              ) : null}
              {/* The universal `Watch…` entry (§2.1), pre-filled with this run's
                  recommendation: tell me when it finishes. Only while the run can
                  still change — a finished run has nothing left to wait for. */}
              {isFinalRunStatus(run.status) ? null : (
                <WatchButton
                  spec={runWatchRecommendation(run.friendlyId)}
                  variant="primary"
                  className="self-start"
                />
              )}
              <RunTimeline run={run} />

              {run.error && (
                <div className="flex flex-col gap-2">
                  <RunError error={run.error} />
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
          {run.friendlyId !== runParam && (
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

// Trust a ClickHouse gauge only while its newest bucket is recent (10s bucket + pipeline lag);
// once it ages out, fall back to the loader's live Redis value instead of a stale count.
const LIVE_GAUGE_FRESH_MS = 90_000;

const WAITING_STATUS_LABELS: Partial<Record<SpanRun["status"], string>> = {
  PENDING: "Queued",
  DELAYED: "Delayed",
  PENDING_VERSION: "Pending version",
};

// A mini version of the queue page's stat block: same chrome, title font and alignment, smaller value.
function MiniStat({
  title,
  value,
  valueClassName,
  suffix,
  accessory,
}: {
  title: ReactNode;
  value: ReactNode;
  valueClassName?: string;
  suffix?: ReactNode;
  accessory?: ReactNode;
}) {
  return (
    <div className="flex min-h-[5.5rem] flex-col justify-between gap-3 rounded-sm border border-grid-dimmed bg-background-bright p-3">
      <div className="flex items-center justify-between gap-1">
        <Header3 className="leading-6">{title}</Header3>
        {accessory ? <div className="-my-1 shrink-0">{accessory}</div> : null}
      </div>
      <div className="flex flex-wrap items-baseline gap-1">
        <span
          className={cn(
            "text-2xl font-normal leading-none tabular-nums text-text-bright",
            valueClassName
          )}
        >
          {value}
        </span>
        {suffix ? <span className="text-xs tabular-nums text-text-dimmed">{suffix}</span> : null}
      </div>
    </div>
  );
}

const EXTERNAL_DEPLOYMENT_ID_DISPLAY_LENGTH = 24;

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

// A compact "mini queue" for a waiting run: the queue page's stat blocks + charts, scaled down.
function WaitingInQueueBlock({
  queueName,
  queuePath,
  paused,
  waiting,
  status,
  createdAt,
  loadedAt,
  runFriendlyId,
}: {
  queueName: string;
  queuePath: string | undefined;
  paused: boolean;
  waiting: RunQueueWaiting;
  status: SpanRun["status"];
  createdAt: Date;
  loadedAt: number;
  runFriendlyId: string;
}) {
  // Latest gauges from ClickHouse (as on the queue page), polled so the blocks keep ticking. Trust
  // the newest bucket only while fresh; otherwise fall back to the loader's live values.
  const {
    rows: liveRows,
    responseReceivedAt,
    lastSuccessfulResponseAt,
  } = useQueueMetric(
    `SELECT timeBucket() AS t, max(max_running) AS running, max(max_queued) AS queued, max(max_limit) AS q_limit\nFROM queue_metrics\nGROUP BY t\nORDER BY t`,
    {
      ids: waiting.ids,
      timeRange: { period: "15m", from: null, to: null },
      defaultPeriod: "15m",
      queueName,
      refreshIntervalMs: 15_000,
    }
  );
  const latest = liveRows.length > 0 ? liveRows[liveRows.length - 1] : undefined;
  const latestBucketMs = latest ? clickhouseTimeToMs(latest.t) : NaN;
  const now = Math.max(loadedAt, lastSuccessfulResponseAt ?? loadedAt);
  const liveFresh = useIsMetricResponseFresh(
    responseReceivedAt,
    latestBucketMs,
    LIVE_GAUGE_FRESH_MS
  );
  const fresh = latest && liveFresh ? latest : undefined;

  const key = waiting.concurrencyKey;
  const running = fresh ? toNumber(fresh.running) : waiting.running;
  const limit = waiting.concurrencyLimit ?? (fresh ? toNumber(fresh.q_limit) || null : null);

  // The concurrency limit applies per key on keyed queues, so the tile has to compare like with
  // like: the key's own running count against the per-key limit. `running` above is queue-wide,
  // which would render "8 / 2 · 100%" while this run's key sits at 1 of 2. PENDING renders as
  // "Queued".
  const runningAgainstLimit = key ? key.running : running;
  const atLimit = limit !== null && runningAgainstLimit >= limit;
  const showAtLimit = status === "PENDING" && atLimit && !paused;
  const pct =
    limit && limit > 0 ? Math.min(100, Math.round((runningAgainstLimit / limit) * 100)) : null;
  const waitedMs = Math.max(0, now - new Date(createdAt).getTime());

  // Why the run is held, surfaced as a warning icon on the Status tile (queue-page style) rather
  // than a separate sentence.
  const warningMessage = paused
    ? "Queue is paused. Runs will not start until it is resumed."
    : showAtLimit
      ? "At the concurrency limit. This run starts when a running one finishes."
      : null;

  return (
    <div className="@container flex flex-col gap-3 border-b border-grid-bright pb-4">
      {/* Responsive to the side panel width (container query, not viewport): 3-up while there's
          room, stacking to a single column only once the panel gets narrow. */}
      <div className="grid grid-cols-1 gap-2 @[22rem]:grid-cols-3">
        <MiniStat
          title={
            <span className="flex items-center gap-1.5">
              Status
              {warningMessage ? (
                <SimpleTooltip
                  button={<ExclamationTriangleIcon className="size-4 text-warning" />}
                  content={warningMessage}
                />
              ) : null}
            </span>
          }
          value={WAITING_STATUS_LABELS[status] ?? "Waiting"}
          valueClassName="tracking-tight"
        />
        <MiniStat
          title="Concurrency"
          value={runningAgainstLimit.toLocaleString()}
          valueClassName={cn(atLimit && "text-warning")}
          suffix={
            limit !== null
              ? `/ ${limit.toLocaleString()}${pct !== null ? ` · ${pct}%` : ""}`
              : "of ∞"
          }
        />
        <MiniStat
          title="Waiting for"
          value={formatDurationMilliseconds(waitedMs, { style: "short", maxDecimalPoints: 0 })}
        />
      </div>

      <div className="rounded-sm border border-grid-dimmed bg-background-bright p-3">
        <div className="mb-2 flex items-center justify-between gap-1.5">
          <div className="flex items-center gap-1.5">
            <Header3 className="leading-6">Scheduling delay</Header3>
            <InfoIconTooltip
              content="Wait from eligible to dequeued (p50/p95)."
              contentClassName="max-w-xs"
            />
          </div>
          {queuePath ? (
            <LinkButton
              variant="secondary/small-icon"
              LeadingIcon={QueuesIcon}
              leadingIconClassName="text-queues"
              to={queuePath}
              tooltip="View queue"
            />
          ) : null}
        </div>
        <div className="h-40">
          <QueueMetricChart
            query={`SELECT timeBucket() AS t,\n  round(quantilesMerge(0.5, 0.9, 0.95, 0.99)(wait_quantiles)[1]) AS p50,\n  round(quantilesMerge(0.5, 0.9, 0.95, 0.99)(wait_quantiles)[3]) AS p95\nFROM queue_metrics\nGROUP BY t\nORDER BY t`}
            series={[
              { key: "p50", label: "p50", color: QUEUE_METRIC_COLORS.p50 },
              { key: "p95", label: "p95", color: QUEUE_METRIC_COLORS.p95 },
            ]}
            ids={waiting.ids}
            timeRange={{ period: "30m", from: null, to: null }}
            defaultPeriod="30m"
            queueName={queueName}
            valueFormat={formatWaitMs}
            fillGaps
          />
        </div>
      </div>

      {/* This block only exists while the run is still waiting, so the ask is always apt: hand the
          stuck run to the agent. Hidden when the agent isn't available. */}
      <InvestigateButton
        prompt={waitingRunPrompt(runFriendlyId, queueName)}
        className="self-start"
      />
    </div>
  );
}

// Trace export menu items: copy the trace as Markdown (for pasting into an AI
// assistant) plus a download per format. The export route streams `?format=`
// server-side.
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

function RunError({ error }: { error: TaskRunError }) {
  const enhancedError = taskRunErrorEnhancer(error);

  switch (enhancedError.type) {
    case "STRING_ERROR":
      return (
        <div className="flex flex-col gap-2 rounded-sm border border-rose-500/50 px-3 pb-3 pt-2">
          <Header3 className="text-rose-500">Error</Header3>
          <Callout variant="error">{enhancedError.raw}</Callout>
        </div>
      );
    case "CUSTOM_ERROR": {
      return (
        <div className="flex flex-col gap-2 rounded-sm border border-rose-500/50 px-3 pb-3 pt-2">
          <CodeBlock
            showCopyButton={false}
            showLineNumbers={false}
            code={enhancedError.raw}
            maxLines={20}
          />
        </div>
      );
    }
    case "BUILT_IN_ERROR":
    case "INTERNAL_ERROR": {
      const name = "name" in enhancedError ? enhancedError.name : enhancedError.code;
      return (
        <div className="flex flex-col gap-2 rounded-sm border border-rose-500/50 px-3 pb-3 pt-2">
          <Header3 className="text-rose-500">{name}</Header3>
          {enhancedError.message && (
            <Callout variant="error">
              <pre className="text-wrap font-sans text-sm font-normal text-rose-500 dark:text-rose-200 [word-break:break-word]">
                {enhancedError.message}
              </pre>
            </Callout>
          )}
          {enhancedError.link &&
            (enhancedError.link.magic === "CONTACT_FORM" ? (
              <Feedback
                button={
                  <Button
                    variant="tertiary/medium"
                    LeadingIcon={EnvelopeIcon}
                    leadingIconClassName="text-blue-400"
                    fullWidth
                    textAlignLeft
                  >
                    {enhancedError.link.name}
                  </Button>
                }
              />
            ) : (
              <Callout variant="docs" to={enhancedError.link.href}>
                {enhancedError.link.name}
              </Callout>
            ))}
          {enhancedError.stackTrace && (
            <CodeBlock
              showCopyButton={false}
              showLineNumbers={false}
              code={enhancedError.stackTrace}
              maxLines={20}
            />
          )}
        </div>
      );
    }
  }
}
function SpanEntity({ span }: { span: Span }) {
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
                <TextLink to={docsPath("wait")}>View docs</TextLink>.
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
