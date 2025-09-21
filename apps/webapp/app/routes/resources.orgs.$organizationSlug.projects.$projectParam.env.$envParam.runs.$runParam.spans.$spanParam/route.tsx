import {
  CheckIcon,
  CloudArrowDownIcon,
  EnvelopeIcon,
  QueueListIcon,
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
import { redirectWithErrorMessage } from "~/models/message.server";
import { type Span, SpanPresenter, type SpanRun } from "~/presenters/v3/SpanPresenter.server";
import { logger } from "~/services/logger.server";
import { cn } from "~/utils/cn";
import { formatCurrencyAccurate } from "~/utils/numberFormatter";
import {
  docsPath,
  v3BatchPath,
  v3DeploymentVersionPath,
  v3RunDownloadLogsPath,
  v3RunPath,
  v3RunRedirectPath,
  v3RunSpanPath,
  v3RunsPath,
  v3SchedulePath,
  v3SpanParamsSchema,
} from "~/utils/pathBuilder";
import { createTimelineSpanEventsFromSpanEvents } from "~/utils/timelineSpanEvents";
import { CompleteWaitpointForm } from "../resources.orgs.$organizationSlug.projects.$projectParam.env.$envParam.waitpoints.$waitpointFriendlyId.complete/route";
import { requireUserId } from "~/services/session.server";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const userId = await requireUserId(request);
  const { projectParam, organizationSlug, envParam, runParam, spanParam } =
    v3SpanParamsSchema.parse(params);

  const presenter = new SpanPresenter();

  try {
    const result = await presenter.call({
      projectSlug: projectParam,
      spanId: spanParam,
      runFriendlyId: runParam,
      userId,
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
  closePanel,
}: {
  runParam: string;
  spanId: string | undefined;
  closePanel?: () => void;
}) {
  const organization = useOrganization();
  const project = useProject();
  const environment = useEnvironment();
  const fetcher = useTypedFetcher<typeof loader>();

  useEffect(() => {
    if (spanId === undefined) return;
    fetcher.load(
      `/resources/orgs/${organization.slug}/projects/${project.slug}/env/${environment.slug}/runs/${runParam}/spans/${spanId}`
    );
  }, [organization.slug, project.slug, environment.slug, runParam, spanId]);

  if (spanId === undefined) {
    return null;
  }

  if (fetcher.state !== "idle" || fetcher.data === undefined) {
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
      return <SpanBody span={fetcher.data.span} runParam={runParam} closePanel={closePanel} />;
    }
  }
}

function SpanBody({
  span,
  runParam,
  closePanel,
}: {
  span: Span;
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

  return (
    <div className="grid h-full max-h-full grid-rows-[2.5rem_2rem_1fr] overflow-hidden bg-background-bright">
      <div className="flex items-center justify-between gap-2 overflow-x-hidden px-3">
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
            variant="minimal/medium"
            LeadingIcon={ExitIcon}
            shortcut={{ key: "esc" }}
          />
        )}
      </div>
      <div className="h-fit overflow-x-auto px-3 scrollbar-thin scrollbar-track-transparent scrollbar-thumb-charcoal-600">
        <TabContainer>
          <TabButton
            isActive={!tab || tab === "overview"}
            layoutId="span-span"
            onClick={() => {
              replace({ tab: "overview" });
            }}
            shortcut={{ key: "o" }}
          >
            Overview
          </TabButton>
        </TabContainer>
      </div>
      <div className="overflow-y-auto scrollbar-thin scrollbar-track-transparent scrollbar-thumb-charcoal-600">
        <SpanEntity span={span} />
      </div>
    </div>
  );
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

  return (
    <div className="grid h-full max-h-full grid-rows-[2.5rem_2rem_1fr_3.25rem] overflow-hidden bg-background-bright">
      <div className="flex items-center justify-between gap-2 overflow-x-hidden px-3">
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
            variant="minimal/medium"
            LeadingIcon={ExitIcon}
            shortcut={{ key: "esc" }}
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
                  <Property.Label>Idempotency</Property.Label>
                  <Property.Value>
                    <div className="break-all">{run.idempotencyKey ? run.idempotencyKey : "–"}</div>
                    {run.idempotencyKey && (
                      <div>
                        Expires:{" "}
                        {run.idempotencyKeyExpiresAt ? (
                          <DateTime date={run.idempotencyKeyExpiresAt} />
                        ) : (
                          "–"
                        )}
                      </div>
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
                  <Property.Label>Run ID</Property.Label>
                  <Property.Value>
                    <CopyableText value={run.friendlyId} copyValue={run.friendlyId} asChild />
                  </Property.Value>
                </Property.Item>
                <Property.Item>
                  <Property.Label>Internal ID</Property.Label>
                  <Property.Value>
                    <CopyableText value={run.id} copyValue={run.id} asChild />
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
      <div className="flex items-center justify-between gap-2 border-t border-grid-dimmed px-2">
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
        <div className="flex items-center gap-4">
          {run.logsDeletedAt === null ? (
            <LinkButton
              to={v3RunDownloadLogsPath({ friendlyId: runParam })}
              LeadingIcon={CloudArrowDownIcon}
              leadingIconClassName="text-indigo-400"
              variant="secondary/medium"
              target="_blank"
              download
            >
              Download logs
            </LinkButton>
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
    default: {
      assertNever(span.entity);
    }
  }
}
