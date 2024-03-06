import { useParams } from "@remix-run/react";
import { LoaderFunctionArgs } from "@remix-run/server-runtime";
import { formatDurationNanoseconds, nanosecondsToMilliseconds } from "@trigger.dev/core/v3";
import { ReactNode } from "react";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { ExitIcon } from "~/assets/icons/ExitIcon";
import { CodeBlock } from "~/components/code/CodeBlock";
import { EnvironmentLabel } from "~/components/environments/EnvironmentLabel";
import { LinkButton } from "~/components/primitives/Buttons";
import { DateTimeAccurate } from "~/components/primitives/DateTime";
import { Header2 } from "~/components/primitives/Headers";
import { Paragraph } from "~/components/primitives/Paragraph";
import { LiveTimer } from "~/components/runs/v3/LiveTimer";
import { RunIcon } from "~/components/runs/v3/RunIcon";
import { SpanEvents } from "~/components/runs/v3/SpanEvents";
import { SpanTitle } from "~/components/runs/v3/SpanTitle";
import { TaskPath } from "~/components/runs/v3/TaskPath";
import { TaskRunStatus } from "~/components/runs/v3/TaskRunStatus";
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
import { SpanPresenter } from "~/presenters/v3/SpanPresenter.server";
import { requireUserId } from "~/services/session.server";
import { cn } from "~/utils/cn";
import { v3RunPath, v3SpanParamsSchema } from "~/utils/pathBuilder";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const userId = await requireUserId(request);
  const { projectParam, organizationSlug, spanParam } = v3SpanParamsSchema.parse(params);

  const presenter = new SpanPresenter();
  const span = await presenter.call({
    userId,
    organizationSlug,
    projectSlug: projectParam,
    spanId: spanParam,
  });

  return typedjson({ span });
};

export default function Page() {
  const {
    span: { event },
  } = useTypedLoaderData<typeof loader>();
  const organization = useOrganization();
  const project = useProject();
  const { runParam } = useParams();

  return (
    <div className="grid h-full max-h-full grid-rows-[2.5rem_1fr] overflow-hidden bg-background-bright">
      <div className="mx-3 flex items-center justify-between gap-2 border-b border-grid-dimmed">
        <div className="flex items-center gap-1 overflow-x-hidden">
          <RunIcon name={event.style?.icon} className="h-4 min-h-4 w-4 min-w-4" />
          <Header2 className={cn("whitespace-nowrap")}>
            <SpanTitle {...event} size="large" />
          </Header2>
        </div>
        {runParam && (
          <LinkButton
            to={v3RunPath(organization, project, { friendlyId: runParam })}
            variant="minimal/medium"
            LeadingIcon={ExitIcon}
            shortcut={{ key: "esc" }}
          />
        )}
      </div>
      <div className="overflow-y-auto px-3 pt-4 scrollbar-thin scrollbar-track-transparent scrollbar-thumb-charcoal-600">
        <div className="flex flex-col gap-4">
          <PropertyTable>
            {event.level === "TRACE" ? (
              <Property label="Timeline" labelClassName="self-end">
                <Timeline
                  startTime={new Date(event.startTime)}
                  duration={event.duration}
                  inProgress={event.isPartial}
                  isError={event.isError}
                />
              </Property>
            ) : (
              <Property label="Timestamp">
                <Paragraph variant="small/bright">
                  <DateTimeAccurate date={event.startTime} /> UTC
                </Paragraph>
              </Property>
            )}
            {event.style.variant === "primary" && (
              <Property label="Status">
                <TaskRunStatus
                  status={
                    event.isCancelled
                      ? "CANCELED"
                      : event.isError
                      ? "FAILED"
                      : event.isPartial
                      ? "EXECUTING"
                      : "COMPLETED"
                  }
                  className="text-sm"
                />
              </Property>
            )}
            <Property label="Message">{event.message}</Property>
            <Property label="Task ID">{event.taskSlug}</Property>
            {event.taskPath && event.taskExportName && (
              <Property label="Task">
                <TaskPath
                  filePath={event.taskPath}
                  functionName={`${event.taskExportName}()`}
                  className="text-xs"
                />
              </Property>
            )}

            {event.queueName && <Property label="Queue name">{event.queueName}</Property>}
            {event.workerVersion && (
              <Property label="Version">
                <div className="flex items-center gap-2 text-sm text-text-bright">
                  <span>{event.workerVersion}</span>
                  <EnvironmentLabel environment={{ type: event.environmentType }} />
                </div>
              </Property>
            )}
          </PropertyTable>

          {event.events !== undefined && <SpanEvents spanEvents={event.events} />}

          {event.payload && (
            <div>
              <Header2 spacing>Payload</Header2>
              <CodeBlock code={event.payload} maxLines={20} />
            </div>
          )}

          {event.output && (
            <div>
              <Header2 spacing>Output</Header2>
              <CodeBlock code={event.output} maxLines={20} />
            </div>
          )}
          {event.properties !== undefined && (
            <div>
              <Header2 spacing>Properties</Header2>
              <CodeBlock code={event.properties} maxLines={20} />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function PropertyTable({ children, className }: { children: ReactNode; className?: string }) {
  return <div className="grid grid-cols-[auto,1fr] items-baseline gap-x-4 gap-y-2">{children}</div>;
}

type PropertyProps = {
  label: ReactNode;
  labelClassName?: string;
  children: ReactNode;
};

function Property({ label, labelClassName, children }: PropertyProps) {
  return (
    <>
      <div className={labelClassName}>
        {typeof label === "string" ? <Paragraph variant="small">{label}</Paragraph> : label}
      </div>
      <div>
        {typeof children === "string" ? (
          <Paragraph variant="small/bright">{children}</Paragraph>
        ) : (
          children
        )}
      </div>
    </>
  );
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
          <DateTimeAccurate date={startTime} /> UTC
        </Paragraph>
        {state === "pending" ? (
          <LiveTimer startTime={startTime} className="" />
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
