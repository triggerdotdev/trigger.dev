import {
  ArrowPathIcon,
  ArrowRightIcon,
  BookOpenIcon,
  CheckIcon,
  ChevronUpIcon,
  ClockIcon,
  CloudArrowDownIcon,
  EnvelopeIcon,
  GlobeAltIcon,
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
import { useEffect } from "react";
import { typedjson, useTypedFetcher } from "remix-typedjson";
import { ExitIcon } from "~/assets/icons/ExitIcon";
import { FlagIcon } from "~/assets/icons/RegionIcons";
import { AdminDebugRun } from "~/components/admin/debugRun";
import { CodeBlock } from "~/components/code/CodeBlock";
import { EnvironmentCombo } from "~/components/environments/EnvironmentLabel";
import { Feedback } from "~/components/Feedback";
import { MachineLabelCombo } from "~/components/MachineLabelCombo";
import { MachineTooltipInfo } from "~/components/MachineTooltipInfo";
import { Button, LinkButton } from "~/components/primitives/Buttons";
import { Callout } from "~/components/primitives/Callout";
import { CopyableText } from "~/components/primitives/CopyableText";
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
import { InfoIconTooltip, SimpleTooltip } from "~/components/primitives/Tooltip";
import { RunTimeline, RunTimelineEvent, SpanTimeline } from "~/components/run/RunTimeline";
import { PacketDisplay } from "~/components/runs/v3/PacketDisplay";
import { RunIcon } from "~/components/runs/v3/RunIcon";
import { RunTag } from "~/components/runs/v3/RunTag";
import { SpanEvents } from "~/components/runs/v3/SpanEvents";
import { SpanTitle } from "~/components/runs/v3/SpanTitle";
import { TaskRunAttemptStatusCombo } from "~/components/runs/v3/TaskRunAttemptStatus";
import {
  descriptionForTaskRunStatus,
  TaskRunStatusCombo,
} from "~/components/runs/v3/TaskRunStatus";
import { WaitpointDetailTable } from "~/components/runs/v3/WaitpointDetails";
import { RuntimeIcon } from "~/components/RuntimeIcon";
import { WarmStartCombo } from "~/components/WarmStarts";
import { useEnvironment } from "~/hooks/useEnvironment";
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
import { useSearchParams } from "~/hooks/useSearchParam";
import { useHasAdminAccess } from "~/hooks/useUser";
import { useCanViewLogsPage } from "~/hooks/useCanViewLogsPage";
import { redirectWithErrorMessage } from "~/models/message.server";
import { type Span, SpanPresenter, type SpanRun } from "~/presenters/v3/SpanPresenter.server";
import { logger } from "~/services/logger.server";
import { requireUserId } from "~/services/session.server";
import { cn } from "~/utils/cn";
import { formatCurrencyAccurate } from "~/utils/numberFormatter";
import {
  docsPath,
  v3BatchPath,
  v3DeploymentVersionPath,
  v3LogsPath,
  v3RunDownloadLogsPath,
  v3RunIdempotencyKeyResetPath,
  v3RunPath,
  v3RunRedirectPath,
  v3RunSpanPath,
  v3RunsPath,
  v3SchedulePath,
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
      spanId: spanParam,
      runFriendlyId: runParam,
      userId,
      linkedRunId,
    });

    return typedjson(result);
  } catch (error) {
    logger.error("Error loading span", {
      projectParam,
      organizationSlug,
      runParam,
      spanParam,
      error,
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

  useEffect(() => {
    if (spanId === undefined) return;
    const url = `/resources/orgs/${organization.slug}/projects/${project.slug}/env/${
      environment.slug
    }/runs/${runParam}/spans/${spanId}${linkedRunId ? `?linkedRunId=${linkedRunId}` : ""}`;
    fetcher.load(url);
  }, [organization.slug, project.slug, environment.slug, runParam, spanId, linkedRunId]);

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
  const organization = useOrganization();
  const project = useProject();
  const environment = useEnvironment();
  const { value, replace } = useSearchParams();
  let tab = value("tab");

  if (tab === "context") {
    tab = "overview";
  }

  span = applySpanOverrides(span, spanOverrides);

  return (
    <div className="grid h-full max-h-full grid-rows-[2.5rem_1fr] overflow-hidden bg-background-bright">
      <div className="flex items-center justify-between gap-2 overflow-x-hidden border-b border-grid-bright px-3 pr-2">
        <div className="flex items-center gap-1 overflow-x-hidden">
          <RunIcon
            name={span.style?.icon}
            spanName={span.message}
            className="size-5 min-h-5 min-w-5"
          />
          <Header2 className={cn("overflow-x-hidden")}>
            <SpanTitle {...span} size="large" hideAccessory />
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
      <div className="overflow-y-auto scrollbar-thin scrollbar-track-transparent scrollbar-thumb-charcoal-600">
        <SpanEntity span={span} />
      </div>
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
  runParam,
  spanId,
  closePanel,
}: {
  run: SpanRun;
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
  const canViewLogsPage = useCanViewLogsPage();

  return (
    <div className="grid h-full max-h-full grid-rows-[2.5rem_2rem_1fr_minmax(3.25rem,auto)] overflow-hidden bg-background-bright">
      <div className="flex items-center justify-between gap-2 overflow-x-hidden px-3 pr-2">
        <div className="flex items-center gap-1 overflow-x-hidden">
          <RunIcon
            name={run.isCached ? "task-cached" : "task"}
            spanName={run.taskIdentifier}
            className="size-5 min-h-5 min-w-5"
          />
          <Header2 className={cn("overflow-x-hidden text-blue-500")}>
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
      <div className="h-fit overflow-x-auto px-3 scrollbar-thin scrollbar-track-transparent scrollbar-thumb-charcoal-600">
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
      <div className="overflow-y-auto px-3 scrollbar-thin scrollbar-track-transparent scrollbar-thumb-charcoal-600">
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
                                <Paragraph variant="small" className="!text-wrap text-text-dimmed">
                                  Prevent duplicate task runs. If you trigger a task with the same
                                  key twice, the second request returns the original run.
                                </Paragraph>
                              </div>
                              <div>
                                <div className="mb-1 flex items-center gap-1">
                                  <GlobeAltIcon className="size-4 text-blue-500" />
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
                    <div>Name: {run.queue.name}</div>
                    <div>
                      Concurrency key: {run.queue.concurrencyKey ? run.queue.concurrencyKey : "–"}
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
                      <span className="flex items-center gap-1">
                        {run.region.location ? (
                          <FlagIcon region={run.region.location} className="size-5" />
                        ) : null}
                        {run.region.name}
                      </span>
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
              <div className="border-b border-grid-bright pb-3">
                <SimpleTooltip
                  button={<TaskRunStatusCombo status={run.status} className="text-sm" />}
                  content={descriptionForTaskRunStatus(run.status)}
                />
              </div>
              <RunTimeline run={run} />

              {run.error && <RunError error={run.error} />}

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
      <div className="flex items-center flex-wrap py-2 justify-between gap-2 border-t border-grid-dimmed px-2">
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
          <AdminDebugRun friendlyId={run.friendlyId} />
        </div>
        <div className="flex items-center">
          {run.logsDeletedAt === null ? (
            canViewLogsPage ? (
              <div className="flex">
                <LinkButton
                  to={`${v3LogsPath(organization, project, environment)}?runId=${runParam}&from=${
                    new Date(run.createdAt).getTime() - 60000
                  }`}
                  variant="secondary/medium"
                  className="rounded-r-none border-r-0"
                >
                  View logs
                </LinkButton>
                <Popover>
                  <PopoverTrigger asChild>
                    <Button
                      variant="secondary/medium"
                      className="rounded-l-none border-l-charcoal-700 px-1.5"
                    >
                      <ChevronUpIcon className="size-4 transition group-hover/button:text-text-bright" />
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent className="min-w-[140px] p-1" align="end">
                    <PopoverMenuItem
                      to={`${v3LogsPath(organization, project, environment)}?runId=${runParam}&from=${
                        new Date(run.createdAt).getTime() - 60000
                      }`}
                      title="View logs"
                      icon={ArrowRightIcon}
                      leadingIconClassName="text-blue-500"
                    />
                    <PopoverMenuItem
                      to={v3RunDownloadLogsPath({ friendlyId: runParam })}
                      title="Download logs"
                      icon={CloudArrowDownIcon}
                      leadingIconClassName="text-indigo-500"
                      openInNewTab
                    />
                  </PopoverContent>
                </Popover>
              </div>
            ) : (
              <LinkButton
                to={v3RunDownloadLogsPath({ friendlyId: runParam })}
                LeadingIcon={CloudArrowDownIcon}
                leadingIconClassName="text-indigo-400"
                variant="secondary/medium"
              >
                Download logs
              </LinkButton>
            )
          ) : null}
        </div>
      </div>
    </div>
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
              <pre className="text-wrap font-sans text-sm font-normal text-rose-200 [word-break:break-word]">
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
            <Property.Label>Message</Property.Label>
            <Property.Value className="whitespace-pre-wrap">{span.message}</Property.Value>
          </Property.Item>
          {span.triggeredRuns.length > 0 && (
            <Property.Item>
              <div className="flex flex-col gap-1.5">
                <Header3>Triggered runs</Header3>
                <Table containerClassName="max-h-[12.5rem]">
                  <TableHeader className="bg-background-bright">
                    <TableRow>
                      <TableHeaderCell>Run #</TableHeaderCell>
                      <TableHeaderCell>Task</TableHeaderCell>
                      <TableHeaderCell>Version</TableHeaderCell>
                      <TableHeaderCell>Created at</TableHeaderCell>
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
                            {run.number}
                          </TableCell>
                          <TableCell to={path} actionClassName="py-1.5" rowHoverStyle="bright">
                            {run.taskIdentifier}
                          </TableCell>
                          <TableCell to={path} actionClassName="py-1.5" rowHoverStyle="bright">
                            {run.taskVersion ?? "–"}
                          </TableCell>
                          <TableCell to={path} actionClassName="py-1.5" rowHoverStyle="bright">
                            <DateTime date={run.createdAt} />
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>
            </Property.Item>
          )}
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
          <div className="flex flex-col gap-4 overflow-y-auto px-3 pt-3 scrollbar-thin scrollbar-track-transparent scrollbar-thumb-charcoal-600">
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
        />
      );
    }
    default: {
      assertNever(span.entity);
    }
  }
}
