import { LoaderFunctionArgs } from "@remix-run/server-runtime";
import { formatDurationNanoseconds, nanosecondsToMilliseconds } from "@trigger.dev/core/v3";
import { ReactNode } from "react";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { CodeBlock } from "~/components/code/CodeBlock";
import { DateTime } from "~/components/primitives/DateTime";
import { Header2, Header3 } from "~/components/primitives/Headers";
import { Paragraph } from "~/components/primitives/Paragraph";
import { ShortcutKey } from "~/components/primitives/ShortcutKey";
import { eventTextClassName } from "~/components/runs/v3/EventText";
import { LiveTimer } from "~/components/runs/v3/LiveTimer";
import { RunIcon } from "~/components/runs/v3/RunIcon";
import { SpanPresenter } from "~/presenters/v3/SpanPresenter.server";
import { requireUserId } from "~/services/session.server";
import { cn } from "~/utils/cn";
import { v3SpanParamsSchema } from "~/utils/pathBuilder";

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

  return (
    <div className="grid max-h-full grid-rows-[2rem_1fr] overflow-hidden">
      <div className="border-b border-slate-800">
        <div className="flex h-8 items-center justify-between gap-2 border-b border-ui-border px-2">
          <div className="flex items-center gap-1 overflow-x-hidden">
            <RunIcon name={event.style?.icon} className="min-w-4 min-h-4 h-4 w-4" />
            <Header2 className={cn("whitespace-nowrap", eventTextClassName(event))}>
              {event.message}
            </Header2>
          </div>
          <ShortcutKey shortcut={{ key: "esc" }} variant="small" />
        </div>
      </div>
      <div className="overflow-y-auto px-2 pt-4 scrollbar-thin scrollbar-track-transparent scrollbar-thumb-slate-700">
        <PropertyTable className="mb-4">
          {event.level === "TRACE" ? (
            <Property label="Timeline">
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
                <DateTime date={event.startTime} />
              </Paragraph>
            </Property>
          )}
          <Property label="Message">{event.message}</Property>
        </PropertyTable>

        {event.output !== null && (
          <div>
            <Header3 spacing>Output</Header3>
            <CodeBlock code={event.output} />
          </div>
        )}
        {event.properties !== null && (
          <div>
            <Header3 spacing>Properties</Header3>
            <CodeBlock code={event.properties} />
          </div>
        )}
      </div>
    </div>
  );
}

function PropertyTable({ children, className }: { children: ReactNode; className?: string }) {
  return <div className="grid grid-cols-[auto,1fr] gap-x-4 gap-y-2">{children}</div>;
}

type PropertyProps = {
  label: ReactNode;
  children: ReactNode;
};

function Property({ label, children }: PropertyProps) {
  return (
    <>
      <div>
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
      <div className="flex items-center justify-between">
        <Paragraph variant="small">
          <DateTime date={startTime} />
        </Paragraph>
        {state === "pending" ? (
          <Paragraph variant="small">
            <LiveTimer startTime={startTime} />
          </Paragraph>
        ) : (
          <Paragraph variant="small">
            <DateTime date={new Date(startTime.getTime() + nanosecondsToMilliseconds(duration))} />
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
          <Paragraph variant="small" className="px-1 text-green-500">
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
      <div className="h-0.75 w-0.75 bg-blue-500" />
      <div className="h-0.75 w-0.75 bg-blue-500" />
      <div className="h-0.75 w-0.75 bg-blue-500" />
      <div className="h-0.75 w-0.75 bg-blue-500" />
    </div>
  );
}

function classNameForState(state: TimelineState) {
  switch (state) {
    case "pending": {
      return "bg-blue-500";
    }
    case "complete": {
      return "bg-green-500";
    }
    case "error": {
      return "bg-rose-500";
    }
  }
}
