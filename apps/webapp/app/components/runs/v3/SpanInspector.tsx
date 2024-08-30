import { formatDuration, nanosecondsToMilliseconds } from "@trigger.dev/core/v3";
import { ReactNode } from "react";
import { ExitIcon } from "~/assets/icons/ExitIcon";
import { CodeBlock } from "~/components/code/CodeBlock";
import { Button } from "~/components/primitives/Buttons";
import { DateTimeAccurate } from "~/components/primitives/DateTime";
import { Header2 } from "~/components/primitives/Headers";
import * as Property from "~/components/primitives/PropertyTable";
import { Spinner } from "~/components/primitives/Spinner";
import { TabButton, TabContainer } from "~/components/primitives/Tabs";
import { TextLink } from "~/components/primitives/TextLink";
import { InfoIconTooltip, SimpleTooltip } from "~/components/primitives/Tooltip";
import { LiveTimer } from "~/components/runs/v3/LiveTimer";
import { RunIcon } from "~/components/runs/v3/RunIcon";
import { SpanEvents } from "~/components/runs/v3/SpanEvents";
import { SpanTitle } from "~/components/runs/v3/SpanTitle";
import { TaskRunAttemptStatusCombo } from "~/components/runs/v3/TaskRunAttemptStatus";
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
import { useSearchParams } from "~/hooks/useSearchParam";
import { cn } from "~/utils/cn";
import { v3RunPath, v3RunsPath, v3TraceSpanPath } from "~/utils/pathBuilder";
import { TraceSpan } from "~/utils/taskEvent";
import { SpanLink } from "~/v3/eventRepository.server";

export function SpanInspector({
  span,
  runParam,
  closePanel,
}: {
  span: TraceSpan;
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
