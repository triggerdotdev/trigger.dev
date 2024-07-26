import {
  ArrowPathIcon,
  ClockIcon,
  CloudArrowDownIcon,
  QueueListIcon,
  StopCircleIcon,
} from "@heroicons/react/20/solid";
import { useParams } from "@remix-run/react";
import { LoaderFunctionArgs } from "@remix-run/server-runtime";
import {
  formatDuration,
  formatDurationNanoseconds,
  nanosecondsToMilliseconds,
} from "@trigger.dev/core/v3";
import { ReactNode, useEffect } from "react";
import { typedjson, useTypedFetcher } from "remix-typedjson";
import { ExitIcon } from "~/assets/icons/ExitIcon";
import { CodeBlock } from "~/components/code/CodeBlock";
import { EnvironmentLabel } from "~/components/environments/EnvironmentLabel";
import { Button, LinkButton } from "~/components/primitives/Buttons";
import {
  ClientTabs,
  ClientTabsContent,
  ClientTabsList,
  ClientTabsTrigger,
} from "~/components/primitives/ClientTabs";
import { ClipboardField } from "~/components/primitives/ClipboardField";
import { DateTime, DateTimeAccurate } from "~/components/primitives/DateTime";
import { Dialog, DialogTrigger } from "~/components/primitives/Dialog";
import { Header2 } from "~/components/primitives/Headers";
import { Paragraph } from "~/components/primitives/Paragraph";
import * as Property from "~/components/primitives/PropertyTable";
import { Spinner } from "~/components/primitives/Spinner";
import { TabContainer, TabButton, Tabs } from "~/components/primitives/Tabs";
import { TextLink } from "~/components/primitives/TextLink";
import { CancelRunDialog } from "~/components/runs/v3/CancelRunDialog";
import { LiveTimer } from "~/components/runs/v3/LiveTimer";
import { ReplayRunDialog } from "~/components/runs/v3/ReplayRunDialog";
import { RunIcon } from "~/components/runs/v3/RunIcon";
import { SpanEvents } from "~/components/runs/v3/SpanEvents";
import { SpanTitle } from "~/components/runs/v3/SpanTitle";
import { TaskPath } from "~/components/runs/v3/TaskPath";
import { TaskRunAttemptStatusCombo } from "~/components/runs/v3/TaskRunAttemptStatus";
import { TaskRunStatusCombo } from "~/components/runs/v3/TaskRunStatus";
import { useOptimisticLocation } from "~/hooks/useOptimisticLocation";
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
import { useSearchParams } from "~/hooks/useSearchParam";
import { redirectWithErrorMessage } from "~/models/message.server";
import { Span, SpanPresenter, SpanRun } from "~/presenters/v3/SpanPresenter.server";
import { requireUserId } from "~/services/session.server";
import { cn } from "~/utils/cn";
import {
  v3RunDownloadLogsPath,
  v3RunPath,
  v3RunSpanPath,
  v3RunsPath,
  v3SpanParamsSchema,
  v3TraceSpanPath,
} from "~/utils/pathBuilder";
import { SpanLink } from "~/v3/eventRepository.server";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const userId = await requireUserId(request);
  const { projectParam, organizationSlug, runParam, spanParam } = v3SpanParamsSchema.parse(params);

  const presenter = new SpanPresenter();
  const span = await presenter.call({
    userId,
    organizationSlug,
    projectSlug: projectParam,
    spanId: spanParam,
    runFriendlyId: runParam,
  });

  if (!span) {
    // We're going to redirect to the run page
    return redirectWithErrorMessage(
      v3RunPath({ slug: organizationSlug }, { slug: projectParam }, { friendlyId: runParam }),
      request,
      `Event not found.`
    );
  }

  return typedjson({ span });
};

export function SpanView({
  runParam,
  spanId,
  closePanel,
}: {
  runParam: string;
  spanId: string | undefined;
  closePanel: () => void;
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

  const {
    span: { event, run },
  } = fetcher.data;

  return (
    <div
      className={cn(
        "grid h-full max-h-full overflow-hidden bg-background-bright",
        event.showActionBar ? "grid-rows-[2.5rem_1fr_3.25rem]" : "grid-rows-[2.5rem_1fr]"
      )}
    >
      {run ? (
        <RunBody run={run} span={event} runParam={runParam} closePanel={closePanel} />
      ) : (
        <SpanBody span={event} runParam={runParam} closePanel={closePanel} />
      )}
      {event.showActionBar === true ? (
        <div className="flex items-center justify-between gap-2 border-t border-grid-dimmed px-2">
          <div className="flex items-center gap-4">
            {event.runId !== runParam && (
              <LinkButton
                to={v3RunSpanPath(
                  organization,
                  project,
                  { friendlyId: event.runId },
                  { spanId: event.spanId }
                )}
                variant="minimal/medium"
                LeadingIcon={QueueListIcon}
                shortcut={{ key: "f" }}
              >
                Focus on span
              </LinkButton>
            )}
          </div>
          <div className="flex items-center gap-4">
            <RunActionButtons span={event} />
          </div>
        </div>
      ) : null}
    </div>
  );
}

function SpanBody({
  span,
  runParam,
  closePanel,
}: {
  span: Span;
  runParam?: string;
  closePanel: () => void;
}) {
  return (
    <>
      <div className="mx-3 flex items-center justify-between gap-2 overflow-x-hidden border-b border-grid-dimmed">
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
        {runParam && (
          <Button
            onClick={closePanel}
            variant="minimal/medium"
            LeadingIcon={ExitIcon}
            shortcut={{ key: "esc" }}
          />
        )}
      </div>
      <div className="overflow-y-auto px-3 pt-4 scrollbar-thin scrollbar-track-transparent scrollbar-thumb-charcoal-600">
        <div className="flex flex-col gap-4">
          <Property.Table>
            {span.level === "TRACE" ? (
              <Property.Item className="self-end">
                <Property.Label>Timeline</Property.Label>
                <Timeline
                  startTime={new Date(span.startTime)}
                  duration={span.duration}
                  inProgress={span.isPartial}
                  isError={span.isError}
                />
              </Property.Item>
            ) : (
              <Property.Item>
                <Property.Label>Timeline</Property.Label>
                <Property.Value>
                  <DateTimeAccurate date={span.startTime} /> UTC
                </Property.Value>
              </Property.Item>
            )}
            {span.style.variant === "primary" && (
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
            )}
            <Property.Item>
              <Property.Label>Message</Property.Label>
              <Property.Value>{span.message}</Property.Value>
            </Property.Item>
            <Property.Item>
              <Property.Label>Task ID</Property.Label>
              <Property.Value>{span.taskSlug}</Property.Value>
            </Property.Item>
            {span.idempotencyKey && (
              <Property.Item>
                <Property.Label>Idempotency key</Property.Label>
                <Property.Value>{span.idempotencyKey}</Property.Value>
              </Property.Item>
            )}
            {span.taskPath && span.taskExportName && (
              <Property.Item>
                <Property.Label>Task</Property.Label>
                <Property.Value>
                  <TaskPath
                    filePath={span.taskPath}
                    functionName={`${span.taskExportName}()`}
                    className="text-xs"
                  />
                </Property.Value>
              </Property.Item>
            )}

            {span.queueName && (
              <Property.Item>
                <Property.Label>Queue</Property.Label>
                <Property.Value>{span.queueName}</Property.Value>
              </Property.Item>
            )}
            {span.workerVersion && (
              <Property.Item>
                <Property.Label>Version</Property.Label>
                <Property.Value className="flex items-center gap-2 text-text-bright">
                  <span>{span.workerVersion}</span>
                  <EnvironmentLabel environment={{ type: span.environmentType }} />
                </Property.Value>
              </Property.Item>
            )}
          </Property.Table>

          {span.links && span.links.length > 0 && (
            <div>
              <Header2 spacing>Links</Header2>
              <div className="space-y-1">
                {span.links.map((link, index) => (
                  <SpanLinkElement key={index} link={link} />
                ))}
              </div>
            </div>
          )}

          {span.events !== undefined && <SpanEvents spanEvents={span.events} />}
          {span.payload !== undefined && (
            <PacketDisplay data={span.payload} dataType={span.payloadType} title="Payload" />
          )}
          {span.output !== undefined && (
            <PacketDisplay data={span.output} dataType={span.outputType} title="Output" />
          )}
          {span.properties !== undefined && (
            <CodeBlock rowTitle="Properties" code={span.properties} maxLines={20} />
          )}
        </div>
      </div>
    </>
  );
}

function RunBody({
  run,
  span,
  runParam,
  closePanel,
}: {
  run: SpanRun;
  span: Span;
  runParam?: string;
  closePanel: () => void;
}) {
  const organization = useOrganization();
  const project = useProject();
  const { value, replace } = useSearchParams();

  const tab = value("tab");

  return (
    <>
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
        {runParam && (
          <Button
            onClick={closePanel}
            variant="minimal/medium"
            LeadingIcon={ExitIcon}
            shortcut={{ key: "esc" }}
          />
        )}
      </div>
      <div className="overflow-y-auto px-3 scrollbar-thin scrollbar-track-transparent scrollbar-thumb-charcoal-600">
        <div>
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
          </TabContainer>
          {tab === "detail" ? (
            <div className="flex flex-col gap-4 pt-3">
              <TaskRunStatusCombo status={run.status} className="text-sm" />
              {/* <PropertyTable>
        <Property label="Status">
          <TaskRunStatusCombo status={run.status} />
        </Property>
        <Property label="Timeline">
          <TaskRunStatusCombo status={run.status} />
        </Property>
        <Property label="Task">
          <TextLink to={v3RunsPath(organization, project, { tasks: [run.taskIdentifier] })}>
            {run.taskIdentifier}
          </TextLink>
        </Property>
      </PropertyTable> */}
            </div>
          ) : (
            <div className="flex flex-col gap-4 pt-3">
              <div className="border-b border-grid-bright pb-3">
                <TaskRunStatusCombo status={run.status} className="text-sm" />
              </div>
              <RunTimeline run={run} />
              {span.events !== undefined && <SpanEvents spanEvents={span.events} />}
              {span.payload !== undefined && (
                <CodeBlock rowTitle="Payload" code={span.payload} maxLines={20} />
              )}
            </div>
          )}
        </div>
      </div>
    </>
  );
}

function RunTimeline({ run }: { run: SpanRun }) {
  return (
    <div className="min-w-fit max-w-80">
      <RunTimelineEvent
        title="Triggered"
        subtitle={<DateTime date={run.createdAt} />}
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
          subtitle={<DateTime date={run.expiredAt} />}
          state="error"
        />
      ) : run.startedAt ? (
        <>
          <RunTimelineEvent
            title="Started"
            subtitle={<DateTime date={run.startedAt} />}
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
                subtitle={<DateTime date={run.updatedAt} />}
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
        {subtitle ? <span className="text-text-dimmed">{subtitle}</span> : null}
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
            state === "complete"
              ? "bg-success"
              : state === "delayed"
              ? "bg-text-dimmed"
              : "bg-gradient-to-b from-[#3B82F6] from-50% to-transparent"
          )}
        ></div>
      </div>
      <div className="flex items-center justify-between gap-3">
        <span className="text-text-dimmed">{title}</span>
      </div>
    </div>
  );
}

function RunActionButtons({ span }: { span: Span }) {
  const organization = useOrganization();
  const project = useProject();
  const { runParam } = useParams();

  if (!runParam) return null;

  if (span.isPartial) {
    return (
      <Dialog key="in-progress">
        <LinkButton
          to={v3RunDownloadLogsPath({ friendlyId: runParam })}
          LeadingIcon={CloudArrowDownIcon}
          variant="tertiary/medium"
          target="_blank"
          download
        >
          Download logs
        </LinkButton>
        <DialogTrigger asChild>
          <Button variant="danger/medium" LeadingIcon={StopCircleIcon}>
            Cancel run
          </Button>
        </DialogTrigger>
        <CancelRunDialog
          runFriendlyId={span.runId}
          redirectPath={v3RunSpanPath(
            organization,
            project,
            { friendlyId: runParam },
            { spanId: span.spanId }
          )}
        />
      </Dialog>
    );
  }

  return (
    <Dialog key="complete">
      <LinkButton
        to={v3RunDownloadLogsPath({ friendlyId: runParam })}
        LeadingIcon={CloudArrowDownIcon}
        variant="tertiary/medium"
        target="_blank"
        download
      >
        Download logs
      </LinkButton>
      <DialogTrigger asChild>
        <Button variant="tertiary/medium" LeadingIcon={ArrowPathIcon}>
          Replay run
        </Button>
      </DialogTrigger>
      <ReplayRunDialog
        runFriendlyId={span.runId}
        failedRedirect={v3RunSpanPath(
          organization,
          project,
          { friendlyId: runParam },
          { spanId: span.spanId }
        )}
      />
    </Dialog>
  );
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
      return <CodeBlock language="markdown" rowTitle={title} code={data} maxLines={20} />;
    }
    default: {
      return <CodeBlock language="json" rowTitle={title} code={data} maxLines={20} />;
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

function Timeline({ startTime, duration, inProgress, isError }: TimelineProps) {
  const state = isError ? "error" : inProgress ? "pending" : "complete";
  return (
    <div className="flex w-full flex-col">
      <div className="flex items-center justify-between gap-1">
        <Paragraph variant="small">
          <DateTimeAccurate date={startTime} />
        </Paragraph>
        {state === "pending" ? (
          <Paragraph variant="extra-small" className={cn("whitespace-nowrap tabular-nums")}>
            <LiveTimer startTime={startTime} />
          </Paragraph>
        ) : (
          <Paragraph variant="small">
            <DateTimeAccurate
              date={new Date(startTime.getTime() + nanosecondsToMilliseconds(duration))}
            />
          </Paragraph>
        )}
      </div>
      <TimelineBar duration={duration} state={state} />
    </div>
  );
}

function TimelineBar({
  state,
  duration,
}: Pick<TimelineProps, "duration"> & { state: TimelineState }) {
  return (
    <div className="flex h-6 items-center">
      <VerticalBar state={state} />
      {state === "error" ? (
        <div className={cn("h-0.75 flex-1", classNameForState(state))} />
      ) : state === "complete" ? (
        <div className="flex flex-1 items-center">
          <div className={cn("h-0.75 flex-1", classNameForState(state))} />
          <Paragraph variant="small" className="px-1 text-success">
            {formatDurationNanoseconds(duration, { style: "short" })}
          </Paragraph>
          <div className={cn("h-0.75 flex-1", classNameForState(state))} />
        </div>
      ) : (
        <div className="flex flex-1 items-center">
          <div className={cn("h-0.75 flex-1", classNameForState(state))} />
          <div className={"flex h-0.75 basis-1/6 items-center"}>
            <DottedLine />
          </div>
        </div>
      )}
      {state !== "pending" && <VerticalBar state={state} />}
    </div>
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
        <LinkButton
          to={v3RunPath(organization, project, { friendlyId: link.runId })}
          variant="minimal/medium"
          LeadingIcon={link.icon}
          leadingIconClassName="text-text-dimmed"
          fullWidth
          textAlignLeft
        >
          {link.title}
        </LinkButton>
      );
    }
    case "span": {
      return (
        <LinkButton
          to={v3TraceSpanPath(organization, project, link.traceId, link.spanId)}
          variant="minimal/medium"
          LeadingIcon={link.icon}
          leadingIconClassName="text-text-dimmed"
          fullWidth
          textAlignLeft
        >
          {link.title}
        </LinkButton>
      );
    }
  }

  return null;
}
