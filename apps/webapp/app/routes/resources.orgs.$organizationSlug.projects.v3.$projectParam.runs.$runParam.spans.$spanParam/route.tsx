import { CheckIcon, ClockIcon, CloudArrowDownIcon, QueueListIcon } from "@heroicons/react/20/solid";
import { Link } from "@remix-run/react";
import { LoaderFunctionArgs } from "@remix-run/server-runtime";
import {
  formatDuration,
  formatDurationMilliseconds,
  nanosecondsToMilliseconds,
  TaskRunError,
} from "@trigger.dev/core/v3";
import { ReactNode, useEffect } from "react";
import { typedjson, useTypedFetcher } from "remix-typedjson";
import { ExitIcon } from "~/assets/icons/ExitIcon";
import { CodeBlock } from "~/components/code/CodeBlock";
import { EnvironmentLabel } from "~/components/environments/EnvironmentLabel";
import { Button, LinkButton } from "~/components/primitives/Buttons";
import { Callout } from "~/components/primitives/Callout";
import { DateTime, DateTimeAccurate } from "~/components/primitives/DateTime";
import { Header2, Header3 } from "~/components/primitives/Headers";
import { Paragraph } from "~/components/primitives/Paragraph";
import * as Property from "~/components/primitives/PropertyTable";
import { Spinner } from "~/components/primitives/Spinner";
import { TabButton, TabContainer } from "~/components/primitives/Tabs";
import { TextLink } from "~/components/primitives/TextLink";
import { InfoIconTooltip, SimpleTooltip } from "~/components/primitives/Tooltip";
import { LiveTimer } from "~/components/runs/v3/LiveTimer";
import { RunIcon } from "~/components/runs/v3/RunIcon";
import { RunTag } from "~/components/runs/v3/RunTag";
import { SpanEvents } from "~/components/runs/v3/SpanEvents";
import { SpanTitle } from "~/components/runs/v3/SpanTitle";
import { TaskRunAttemptStatusCombo } from "~/components/runs/v3/TaskRunAttemptStatus";
import { TaskRunStatusCombo } from "~/components/runs/v3/TaskRunStatus";
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
import { useSearchParams } from "~/hooks/useSearchParam";
import { redirectWithErrorMessage } from "~/models/message.server";
import { Span, SpanPresenter, SpanRun } from "~/presenters/v3/SpanPresenter.server";
import { logger } from "~/services/logger.server";
import { requireUserId } from "~/services/session.server";
import { cn } from "~/utils/cn";
import { formatCurrencyAccurate } from "~/utils/numberFormatter";
import {
  v3RunDownloadLogsPath,
  v3RunPath,
  v3RunSpanPath,
  v3RunsPath,
  v3SchedulePath,
  v3SpanParamsSchema,
  v3TraceSpanPath,
} from "~/utils/pathBuilder";
import { SpanLink } from "~/v3/eventRepository.server";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const userId = await requireUserId(request);
  const { projectParam, organizationSlug, runParam, spanParam } = v3SpanParamsSchema.parse(params);

  const presenter = new SpanPresenter();

  try {
    const result = await presenter.call({
      userId,
      organizationSlug,
      projectSlug: projectParam,
      spanId: spanParam,
      runFriendlyId: runParam,
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
      v3RunPath({ slug: organizationSlug }, { slug: projectParam }, { friendlyId: runParam }),
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
  const fetcher = useTypedFetcher<typeof loader>();

  useEffect(() => {
    if (spanId === undefined) return;
    fetcher.load(
      `/resources/orgs/${organization.slug}/projects/v3/${project.slug}/runs/${runParam}/spans/${spanId}`
    );
  }, [organization.slug, project.slug, runParam, spanId]);

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
  const { value, replace } = useSearchParams();
  let tab = value("tab");

  if (tab === "context") {
    tab = "overview";
  }

  return (
    <div className="grid h-full max-h-full grid-rows-[2.5rem_2rem_1fr] overflow-hidden bg-background-bright">
      <div className="mx-3 flex items-center justify-between gap-2 overflow-x-hidden">
        <div className="flex items-center gap-1 overflow-x-hidden">
          <RunIcon
            name={span.style?.icon}
            spanName={span.message}
            className="h-4 min-h-4 w-4 min-w-4"
          />
          <Header2 className={cn("overflow-x-hidden")}>
            <SpanTitle {...span} size="large" />
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
      <div className="px-3">
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
          <TabButton
            isActive={tab === "detail"}
            layoutId="span-span"
            onClick={() => {
              replace({ tab: "detail" });
            }}
            shortcut={{ key: "d" }}
          >
            Detail
          </TabButton>
        </TabContainer>
      </div>
      <div className="overflow-y-auto px-3 scrollbar-thin scrollbar-track-transparent scrollbar-thumb-charcoal-600">
        <div>
          {tab === "detail" ? (
            <div className="flex flex-col gap-4 pt-3">
              <Property.Table>
                <Property.Item>
                  <Property.Label>Status</Property.Label>
                  <Property.Value>
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
                  </Property.Value>
                </Property.Item>
                <Property.Item>
                  <Property.Label>Task</Property.Label>
                  <Property.Value>
                    <SimpleTooltip
                      button={
                        <TextLink
                          to={v3RunsPath(organization, project, { tasks: [span.taskSlug] })}
                        >
                          {span.taskSlug}
                        </TextLink>
                      }
                      content={`Filter runs by ${span.taskSlug}`}
                    />
                  </Property.Value>
                </Property.Item>
                {span.idempotencyKey && (
                  <Property.Item>
                    <Property.Label>Idempotency key</Property.Label>
                    <Property.Value>{span.idempotencyKey}</Property.Value>
                  </Property.Item>
                )}
                <Property.Item>
                  <Property.Label>Version</Property.Label>
                  <Property.Value>
                    {span.workerVersion ? (
                      span.workerVersion
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
                {span.links && span.links.length > 0 && (
                  <Property.Item>
                    <Property.Label>Links</Property.Label>
                    <Property.Value>
                      <div className="space-y-1">
                        {span.links.map((link, index) => (
                          <SpanLinkElement key={index} link={link} />
                        ))}
                      </div>
                    </Property.Value>
                  </Property.Item>
                )}
              </Property.Table>
            </div>
          ) : (
            <div className="flex flex-col gap-4 pt-3">
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
                  />
                </>
              ) : (
                <div className="min-w-fit max-w-80">
                  <RunTimelineEvent
                    title="Timestamp"
                    subtitle={<DateTimeAccurate date={span.startTime} />}
                    state="complete"
                  />
                </div>
              )}
              <Property.Table>
                <Property.Item>
                  <Property.Label>Message</Property.Label>
                  <Property.Value>{span.message}</Property.Value>
                </Property.Item>
                {span.links && span.links.length > 0 && (
                  <Property.Item>
                    <Property.Label>Links</Property.Label>
                    <Property.Value>
                      <div className="space-y-1">
                        {span.links.map((link, index) => (
                          <SpanLinkElement key={index} link={link} />
                        ))}
                      </div>
                    </Property.Value>
                  </Property.Item>
                )}
              </Property.Table>

              {span.events !== undefined && <SpanEvents spanEvents={span.events} />}
              {span.properties !== undefined && (
                <CodeBlock
                  rowTitle="Properties"
                  code={span.properties}
                  maxLines={20}
                  showLineNumbers={false}
                />
              )}
            </div>
          )}
        </div>
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
  const { value, replace } = useSearchParams();
  const tab = value("tab");

  const environment = project.environments.find((e) => e.id === run.environmentId);

  return (
    <div className="grid h-full max-h-full grid-rows-[2.5rem_2rem_1fr_3.25rem] overflow-hidden bg-background-bright">
      <div className="mx-3 flex items-center justify-between gap-2 overflow-x-hidden">
        <div className="flex items-center gap-1 overflow-x-hidden">
          <RunIcon
            name={"task"}
            spanName={run.taskIdentifier}
            className="h-4 min-h-4 w-4 min-w-4"
          />
          <Header2 className={cn("overflow-x-hidden text-blue-500")}>
            <span className="truncate">{run.taskIdentifier}</span>
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
      <div className="px-3">
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
            shortcut={{ key: "c" }}
          >
            Context
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
                    <TaskRunStatusCombo status={run.status} />
                  </Property.Value>
                </Property.Item>
                <Property.Item>
                  <Property.Label>Task</Property.Label>
                  <Property.Value>
                    <SimpleTooltip
                      button={
                        <TextLink
                          to={v3RunsPath(organization, project, { tasks: [run.taskIdentifier] })}
                        >
                          {run.taskIdentifier}
                        </TextLink>
                      }
                      content={`Filter runs by ${run.taskIdentifier}`}
                    />
                  </Property.Value>
                </Property.Item>
                <Property.Item>
                  <Property.Label>Version</Property.Label>
                  <Property.Value>
                    {run.version ? (
                      run.version
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
                  <Property.Label>Test run</Property.Label>
                  <Property.Value>
                    {run.isTest ? <CheckIcon className="size-4 text-text-dimmed" /> : "–"}
                  </Property.Value>
                </Property.Item>
                {environment && (
                  <Property.Item>
                    <Property.Label>Environment</Property.Label>
                    <Property.Value>
                      <EnvironmentLabel environment={environment} />
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
                            <TextLink to={v3SchedulePath(organization, project, run.schedule)}>
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
                        {run.tags.map((tag) => (
                          <SimpleTooltip
                            key={tag}
                            button={
                              <Link to={v3RunsPath(organization, project, { tags: [tag] })}>
                                <RunTag tag={tag} />
                              </Link>
                            }
                            content={`Filter runs by ${tag}`}
                          />
                        ))}
                      </div>
                    )}
                  </Property.Value>
                </Property.Item>
                {run.links && run.links.length > 0 && (
                  <Property.Item>
                    <Property.Label>Links</Property.Label>
                    <Property.Value>
                      <div className="space-y-1">
                        {run.links.map((link, index) => (
                          <SpanLinkElement key={index} link={link} />
                        ))}
                      </div>
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
              </Property.Table>
            </div>
          ) : tab === "context" ? (
            <div className="flex flex-col gap-4 py-3">
              <CodeBlock code={run.context} showLineNumbers={false} />
            </div>
          ) : (
            <div className="flex flex-col gap-4 pt-3">
              <div className="border-b border-grid-bright pb-3">
                <TaskRunStatusCombo status={run.status} className="text-sm" />
              </div>
              <RunTimeline run={run} />
              {run.payload !== undefined && (
                <PacketDisplay data={run.payload} dataType={run.payloadType} title="Payload" />
              )}
              {run.error !== undefined ? (
                <RunError error={run.error} />
              ) : run.output !== undefined ? (
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
              to={v3RunSpanPath(organization, project, { friendlyId: run.friendlyId }, { spanId })}
              variant="minimal/medium"
              LeadingIcon={QueueListIcon}
              shortcut={{ key: "f" }}
            >
              Focus on run
            </LinkButton>
          )}
        </div>
        <div className="flex items-center gap-4">
          {run.logsDeletedAt === null ? (
            <LinkButton
              to={v3RunDownloadLogsPath({ friendlyId: runParam })}
              LeadingIcon={CloudArrowDownIcon}
              variant="tertiary/medium"
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

function RunTimeline({ run }: { run: SpanRun }) {
  return (
    <div className="min-w-fit max-w-80">
      <RunTimelineEvent
        title="Triggered"
        subtitle={<DateTimeAccurate date={run.createdAt} />}
        state="complete"
      />
      {run.delayUntil && !run.expiredAt ? (
        <RunTimelineLine
          title={
            run.startedAt ? (
              <>{formatDuration(run.createdAt, run.delayUntil)} delay</>
            ) : (
              <span className="flex items-center gap-1">
                <ClockIcon className="size-4" />
                <span>
                  Delayed until <DateTime date={run.delayUntil} /> {run.ttl && <>(TTL {run.ttl})</>}
                </span>
              </span>
            )
          }
          state={run.startedAt ? "complete" : "delayed"}
        />
      ) : run.startedAt ? (
        <RunTimelineLine title={formatDuration(run.createdAt, run.startedAt)} state={"complete"} />
      ) : (
        <RunTimelineLine
          title={
            <>
              <LiveTimer
                startTime={run.createdAt}
                endTime={run.startedAt ?? run.expiredAt ?? undefined}
              />{" "}
              {run.ttl && <>(TTL {run.ttl})</>}
            </>
          }
          state={run.startedAt || run.expiredAt ? "complete" : "inprogress"}
        />
      )}
      {run.expiredAt ? (
        <RunTimelineEvent
          title="Expired"
          subtitle={<DateTimeAccurate date={run.expiredAt} />}
          state="error"
        />
      ) : run.startedAt ? (
        <>
          <RunTimelineEvent
            title="Started"
            subtitle={<DateTimeAccurate date={run.startedAt} />}
            state="complete"
          />
          {run.isFinished ? (
            <>
              <RunTimelineLine
                title={formatDuration(run.startedAt, run.updatedAt)}
                state={"complete"}
              />
              <RunTimelineEvent
                title="Finished"
                subtitle={<DateTimeAccurate date={run.updatedAt} />}
                state="complete"
              />
            </>
          ) : (
            <RunTimelineLine
              title={
                <span className="flex items-center gap-1">
                  <Spinner className="size-4" />
                  <span>
                    <LiveTimer startTime={run.startedAt} />
                  </span>
                </span>
              }
              state={"inprogress"}
            />
          )}
        </>
      ) : null}
    </div>
  );
}

type RunTimelineItemProps = {
  title: ReactNode;
  subtitle?: ReactNode;
  state: "complete" | "error";
};

function RunTimelineEvent({ title, subtitle, state }: RunTimelineItemProps) {
  return (
    <div className="grid h-5 grid-cols-[1.125rem_1fr] text-sm">
      <div className="flex items-center justify-center">
        <div
          className={cn(
            "size-[0.3125rem] rounded-full",
            state === "complete" ? "bg-success" : "bg-error"
          )}
        ></div>
      </div>
      <div className="flex items-baseline justify-between gap-3">
        <span className="font-medium text-text-bright">{title}</span>
        {subtitle ? <span className="text-xs text-text-dimmed">{subtitle}</span> : null}
      </div>
    </div>
  );
}

type RunTimelineLineProps = {
  title: ReactNode;
  state: "complete" | "delayed" | "inprogress";
};

function RunTimelineLine({ title, state }: RunTimelineLineProps) {
  return (
    <div className="grid h-6 grid-cols-[1.125rem_1fr] text-xs">
      <div className="flex items-stretch justify-center">
        <div
          className={cn(
            "w-px",
            state === "complete" ? "bg-success" : state === "delayed" ? "bg-text-dimmed" : ""
          )}
          style={
            state === "inprogress"
              ? {
                  width: "1px",
                  height: "100%",
                  background:
                    "repeating-linear-gradient(to bottom, #3B82F6 0%, #3B82F6 50%, transparent 50%, transparent 100%)",
                  backgroundSize: "1px 6px",
                  maskImage: "linear-gradient(to bottom, black 50%, transparent 100%)",
                  WebkitMaskImage: "linear-gradient(to bottom, black 50%, transparent 100%)",
                }
              : undefined
          }
        ></div>
      </div>
      <div className="flex items-center justify-between gap-3">
        <span className="text-text-dimmed">{title}</span>
      </div>
    </div>
  );
}

function RunError({ error }: { error: TaskRunError }) {
  switch (error.type) {
    case "STRING_ERROR":
    case "CUSTOM_ERROR": {
      return (
        <div className="flex flex-col gap-2 rounded-sm border border-rose-500/50 px-3 pb-3 pt-2">
          <CodeBlock
            showCopyButton={false}
            showLineNumbers={false}
            code={error.raw}
            maxLines={20}
          />
        </div>
      );
    }
    case "BUILT_IN_ERROR":
    case "INTERNAL_ERROR": {
      const name = "name" in error ? error.name : error.code;
      return (
        <div className="flex flex-col gap-2 rounded-sm border border-rose-500/50 px-3 pb-3 pt-2">
          <Header3 className="text-rose-500">{name}</Header3>
          {error.message && <Callout variant="error">{error.message}</Callout>}
          {error.stackTrace && (
            <CodeBlock
              showCopyButton={false}
              showLineNumbers={false}
              code={error.stackTrace}
              maxLines={20}
            />
          )}
        </div>
      );
    }
  }
}

function PacketDisplay({
  data,
  dataType,
  title,
}: {
  data: string;
  dataType: string;
  title: string;
}) {
  switch (dataType) {
    case "application/store": {
      return (
        <div className="flex flex-col">
          <Paragraph variant="base/bright" className="w-full border-b border-grid-dimmed py-2.5">
            {title}
          </Paragraph>
          <LinkButton LeadingIcon={CloudArrowDownIcon} to={data} variant="tertiary/medium" download>
            Download
          </LinkButton>
        </div>
      );
    }
    case "text/plain": {
      return (
        <CodeBlock
          language="markdown"
          rowTitle={title}
          code={data}
          maxLines={20}
          showLineNumbers={false}
        />
      );
    }
    default: {
      return (
        <CodeBlock
          language="json"
          rowTitle={title}
          code={data}
          maxLines={20}
          showLineNumbers={false}
        />
      );
    }
  }
}

type TimelineProps = {
  startTime: Date;
  duration: number;
  inProgress: boolean;
  isError: boolean;
};

type TimelineState = "error" | "pending" | "complete";

function SpanTimeline({ startTime, duration, inProgress, isError }: TimelineProps) {
  const state = isError ? "error" : inProgress ? "pending" : "complete";
  return (
    <>
      <div className="min-w-fit max-w-80">
        <RunTimelineEvent
          title="Started"
          subtitle={<DateTimeAccurate date={startTime} />}
          state="complete"
        />
        {state === "pending" ? (
          <RunTimelineLine
            title={
              <span className="flex items-center gap-1">
                <Spinner className="size-4" />
                <span>
                  <LiveTimer startTime={startTime} />
                </span>
              </span>
            }
            state={"inprogress"}
          />
        ) : (
          <>
            <RunTimelineLine
              title={formatDuration(
                startTime,
                new Date(startTime.getTime() + nanosecondsToMilliseconds(duration))
              )}
              state={"complete"}
            />
            <RunTimelineEvent
              title="Finished"
              subtitle={
                <DateTimeAccurate
                  date={new Date(startTime.getTime() + nanosecondsToMilliseconds(duration))}
                />
              }
              state={isError ? "error" : "complete"}
            />
          </>
        )}
      </div>
    </>
  );
}

function VerticalBar({ state }: { state: TimelineState }) {
  return <div className={cn("h-3 w-0.75 rounded-full", classNameForState(state))}></div>;
}

function DottedLine() {
  return (
    <div className="flex h-0.75 flex-1 items-center justify-evenly">
      <div className="h-0.75 w-0.75 bg-pending" />
      <div className="h-0.75 w-0.75 bg-pending" />
      <div className="h-0.75 w-0.75 bg-pending" />
      <div className="h-0.75 w-0.75 bg-pending" />
    </div>
  );
}

function classNameForState(state: TimelineState) {
  switch (state) {
    case "pending": {
      return "bg-pending";
    }
    case "complete": {
      return "bg-success";
    }
    case "error": {
      return "bg-error";
    }
  }
}

function SpanLinkElement({ link }: { link: SpanLink }) {
  const organization = useOrganization();
  const project = useProject();

  switch (link.type) {
    case "run": {
      return (
        <TextLink to={v3RunPath(organization, project, { friendlyId: link.runId })}>
          {link.title}
        </TextLink>
      );
    }
    case "span": {
      return (
        <TextLink to={v3TraceSpanPath(organization, project, link.traceId, link.spanId)}>
          {link.title}
        </TextLink>
      );
    }
  }

  return null;
}
