import {
  ArrowPathIcon,
  CloudArrowDownIcon,
  QueueListIcon,
  StopCircleIcon,
} from "@heroicons/react/20/solid";
import { useParams } from "@remix-run/react";
import { type LoaderFunctionArgs } from "@remix-run/server-runtime";
import {
  formatDurationNanoseconds,
  nanosecondsToMilliseconds,
} from "@trigger.dev/core/v3/utils/durations";
import { useEffect } from "react";
import { typedjson, useTypedFetcher } from "remix-typedjson";
import { ExitIcon } from "~/assets/icons/ExitIcon";
import { CodeBlock } from "~/components/code/CodeBlock";
import { EnvironmentLabel } from "~/components/environments/EnvironmentLabel";
import { Button, LinkButton } from "~/components/primitives/Buttons";
import { DateTimeAccurate } from "~/components/primitives/DateTime";
import { Dialog, DialogTrigger } from "~/components/primitives/Dialog";
import { Header2 } from "~/components/primitives/Headers";
import { Paragraph } from "~/components/primitives/Paragraph";
import { Property, PropertyTable } from "~/components/primitives/PropertyTable";
import { Spinner } from "~/components/primitives/Spinner";
import { CancelRunDialog } from "~/components/runs/v3/CancelRunDialog";
import { LiveTimer } from "~/components/runs/v3/LiveTimer";
import { ReplayRunDialog } from "~/components/runs/v3/ReplayRunDialog";
import { RunIcon } from "~/components/runs/v3/RunIcon";
import { SpanEvents } from "~/components/runs/v3/SpanEvents";
import { SpanTitle } from "~/components/runs/v3/SpanTitle";
import { TaskPath } from "~/components/runs/v3/TaskPath";
import { TaskRunAttemptStatusCombo } from "~/components/runs/v3/TaskRunAttemptStatus";
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
import { redirectWithErrorMessage } from "~/models/message.server";
import { type Span, SpanPresenter } from "~/presenters/v3/SpanPresenter.server";
import { requireUserId } from "~/services/session.server";
import { cn } from "~/utils/cn";
import {
  v3RunDownloadLogsPath,
  v3RunPath,
  v3RunSpanPath,
  v3SpanParamsSchema,
  v3TraceSpanPath,
} from "~/utils/pathBuilder";
import { type SpanLink } from "~/v3/eventRepository.server";

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
    span: { event },
  } = fetcher.data;

  return (
    <div
      className={cn(
        "grid h-full max-h-full overflow-hidden bg-background-bright",
        event.showActionBar ? "grid-rows-[2.5rem_1fr_3.25rem]" : "grid-rows-[2.5rem_1fr]"
      )}
    >
      <div className="mx-3 flex items-center justify-between gap-2 overflow-x-hidden border-b border-grid-dimmed">
        <div className="flex items-center gap-1 overflow-x-hidden">
          <RunIcon
            name={event.style?.icon}
            spanName={event.message}
            className="h-4 min-h-4 w-4 min-w-4"
          />
          <Header2 className={cn("overflow-x-hidden")}>
            <SpanTitle {...event} size="large" />
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
                <TaskRunAttemptStatusCombo
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
            {event.idempotencyKey && (
              <Property label="Idempotency key">{event.idempotencyKey}</Property>
            )}
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

          {event.links && event.links.length > 0 && (
            <div>
              <Header2 spacing>Links</Header2>
              <div className="space-y-1">
                {event.links.map((link, index) => (
                  <SpanLinkElement key={index} link={link} />
                ))}
              </div>
            </div>
          )}

          {event.events !== undefined && <SpanEvents spanEvents={event.events} />}
          {event.payload !== undefined && (
            <PacketDisplay data={event.payload} dataType={event.payloadType} title="Payload" />
          )}
          {event.output !== undefined && (
            <PacketDisplay data={event.output} dataType={event.outputType} title="Output" />
          )}
          {event.properties !== undefined && (
            <CodeBlock rowTitle="Properties" code={event.properties} maxLines={20} />
          )}
        </div>
      </div>
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
