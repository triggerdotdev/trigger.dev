import { ExitIcon } from "~/assets/icons/ExitIcon";
import { CodeBlock } from "~/components/code/CodeBlock";
import { Button } from "~/components/primitives/Buttons";
import { DateTimeAccurate } from "~/components/primitives/DateTime";
import { Header2 } from "~/components/primitives/Headers";
import * as Property from "~/components/primitives/PropertyTable";
import { TabButton, TabContainer } from "~/components/primitives/Tabs";
import { TextLink } from "~/components/primitives/TextLink";
import { InfoIconTooltip, SimpleTooltip } from "~/components/primitives/Tooltip";
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
import { RunTimelineEvent, RunTimelineLine } from "./InspectorTimeline";
import { Spinner } from "~/components/primitives/Spinner";
import { LiveTimer } from "./LiveTimer";
import { formatDuration, nanosecondsToMilliseconds } from "@trigger.dev/core/v3";

export function SpanInspector({
  span,
  runParam,
  closePanel,
}: {
  span?: TraceSpan;
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

  if (span === undefined) {
    return null;
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

type TimelineProps = {
  startTime: Date;
  duration: number;
  inProgress: boolean;
  isError: boolean;
};

export function SpanTimeline({ startTime, duration, inProgress, isError }: TimelineProps) {
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
