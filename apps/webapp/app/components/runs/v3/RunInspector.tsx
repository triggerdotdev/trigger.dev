import { CheckIcon, ClockIcon, CloudArrowDownIcon, QueueListIcon } from "@heroicons/react/20/solid";
import { Link } from "@remix-run/react";
import { formatDuration, formatDurationMilliseconds, TaskRunError } from "@trigger.dev/core/v3";
import { useEffect } from "react";
import { useTypedFetcher } from "remix-typedjson";
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
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
import { useSearchParams } from "~/hooks/useSearchParam";
import { RawRun } from "~/hooks/useSyncTraceRuns";
import { loader } from "~/routes/resources.runs.$runParam";
import { cn } from "~/utils/cn";
import { formatCurrencyAccurate } from "~/utils/numberFormatter";
import {
  v3RunDownloadLogsPath,
  v3RunPath,
  v3RunSpanPath,
  v3RunsPath,
  v3SchedulePath,
  v3TraceSpanPath,
} from "~/utils/pathBuilder";
import { TraceSpan } from "~/utils/taskEvent";
import { SpanLink } from "~/v3/eventRepository.server";
import { isFinalRunStatus } from "~/v3/taskStatus";
import { RunTimelineEvent, RunTimelineLine } from "./InspectorTimeline";
import { RunTag } from "./RunTag";
import { TaskRunStatusCombo } from "./TaskRunStatus";

/**
 * The RunInspector displays live information about a run.
 * Most of that data comes in as params but for some we need to fetch it.
 */
export function RunInspector({
  run,
  span,
  runParam,
  closePanel,
}: {
  run?: RawRun;
  span?: TraceSpan;
  runParam: string;
  closePanel?: () => void;
}) {
  const organization = useOrganization();
  const project = useProject();
  const { value, replace } = useSearchParams();
  const tab = value("tab");

  const fetcher = useTypedFetcher<typeof loader>();

  useEffect(() => {
    if (run?.friendlyId === undefined) return;
    fetcher.load(`/resources/runs/${run.friendlyId}`);
  }, [run?.friendlyId, run?.updatedAt]);

  if (!run) {
    return (
      <div className="grid h-full max-h-full grid-rows-[2.5rem_1fr] overflow-hidden bg-background-bright">
        <div className="mx-3 flex items-center justify-between gap-2 overflow-x-hidden">
          <div className="flex items-center gap-1 overflow-x-hidden">
            <RunIcon name={"task"} spanName="" className="h-4 min-h-4 w-4 min-w-4" />
            <Header2 className={cn("overflow-x-hidden text-blue-500")}>
              <span className="truncate"></span>
            </Header2>
          </div>
          {closePanel && (
            <Button
              onClick={closePanel}
              variant="minimal/medium"
              LeadingIcon={ExitIcon}
              shortcut={{ key: "esc" }}
            />
          )}
        </div>
        <div />
      </div>
    );
  }

  const environment = project.environments.find((e) => e.id === run.runtimeEnvironmentId);
  const clientRunData = fetcher.state === "idle" ? fetcher.data : undefined;

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
        {closePanel && (
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
                    {run ? <TaskRunStatusCombo status={run.status} /> : <PropertyLoading />}
                  </Property.Value>
                </Property.Item>
                <Property.Item>
                  <Property.Label>Task</Property.Label>
                  <Property.Value>
                    <SimpleTooltip
                      button={
                        <TextLink
                          to={v3RunsPath(organization, project, {
                            tasks: [run.taskIdentifier],
                          })}
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
                    {clientRunData ? (
                      clientRunData?.version ? (
                        clientRunData.version
                      ) : (
                        <span className="flex items-center gap-1">
                          <span>Never started</span>
                          <InfoIconTooltip
                            content={"Runs get locked to the latest version when they start."}
                            contentClassName="normal-case tracking-normal"
                          />
                        </span>
                      )
                    ) : (
                      <PropertyLoading />
                    )}
                  </Property.Value>
                </Property.Item>
                <Property.Item>
                  <Property.Label>SDK version</Property.Label>
                  <Property.Value>
                    {clientRunData ? (
                      clientRunData?.sdkVersion ? (
                        clientRunData.sdkVersion
                      ) : (
                        <span className="flex items-center gap-1">
                          <span>Never started</span>
                          <InfoIconTooltip
                            content={"Runs get locked to the latest version when they start."}
                            contentClassName="normal-case tracking-normal"
                          />
                        </span>
                      )
                    ) : (
                      <PropertyLoading />
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

                <Property.Item>
                  <Property.Label>Schedule</Property.Label>
                  <Property.Value>
                    {clientRunData ? (
                      clientRunData.schedule ? (
                        <div>
                          <div className="flex items-center gap-1">
                            <span className="font-mono">
                              {clientRunData.schedule.generatorExpression}
                            </span>
                            <span>({clientRunData.schedule.timezone})</span>
                          </div>
                          <SimpleTooltip
                            button={
                              <TextLink
                                to={v3SchedulePath(organization, project, clientRunData.schedule)}
                              >
                                {clientRunData.schedule.description}
                              </TextLink>
                            }
                            content={`Go to schedule ${clientRunData.schedule.friendlyId}`}
                          />
                        </div>
                      ) : (
                        "No schedule"
                      )
                    ) : (
                      <PropertyLoading />
                    )}
                  </Property.Value>
                </Property.Item>
                <Property.Item>
                  <Property.Label>Queue</Property.Label>
                  <Property.Value>
                    {clientRunData ? (
                      <>
                        <div>Name: {clientRunData.queue.name}</div>
                        <div>
                          Concurrency key:{" "}
                          {clientRunData.queue.concurrencyKey
                            ? clientRunData.queue.concurrencyKey
                            : "–"}
                        </div>
                      </>
                    ) : (
                      <PropertyLoading />
                    )}
                  </Property.Value>
                </Property.Item>
                <Property.Item>
                  <Property.Label>Time to live (TTL)</Property.Label>
                  <Property.Value>{run.ttl ?? "–"}</Property.Value>
                </Property.Item>
                <Property.Item>
                  <Property.Label>Tags</Property.Label>
                  <Property.Value>
                    {clientRunData ? (
                      clientRunData.tags.length === 0 ? (
                        "–"
                      ) : (
                        <div className="mt-1 flex flex-wrap items-center gap-1 text-xs">
                          {clientRunData.tags.map((tag) => (
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
                      )
                    ) : (
                      <PropertyLoading />
                    )}
                  </Property.Value>
                </Property.Item>
                {span?.links && span.links.length > 0 && (
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
              {clientRunData ? (
                <CodeBlock code={clientRunData.context} showLineNumbers={false} />
              ) : (
                <PropertyLoading />
              )}
            </div>
          ) : (
            <div className="flex flex-col gap-4 pt-3">
              <div className="border-b border-grid-bright pb-3">
                <TaskRunStatusCombo status={run.status} className="text-sm" />
              </div>
              <RunTimeline run={run} />
              {clientRunData ? (
                clientRunData.payload !== undefined && (
                  <PacketDisplay
                    data={clientRunData.payload}
                    dataType={clientRunData.payloadType}
                    title="Payload"
                  />
                )
              ) : (
                <PropertyLoading />
              )}
              {clientRunData ? (
                clientRunData.error !== undefined ? (
                  <RunError error={clientRunData.error} />
                ) : clientRunData.output !== undefined ? (
                  <PacketDisplay
                    data={clientRunData.output}
                    dataType={clientRunData.outputType}
                    title="Output"
                  />
                ) : null
              ) : (
                <PropertyLoading />
              )}
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
                { friendlyId: run.friendlyId },
                { spanId: run.spanId }
              )}
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

function PropertyLoading() {
  return <Spinner className="size-4" color="muted" />;
}

function RunTimeline({ run }: { run: RawRun }) {
  const createdAt = new Date(run.createdAt);
  const startedAt = run.startedAt ? new Date(run.startedAt) : null;
  const delayUntil = run.delayUntil ? new Date(run.delayUntil) : null;
  const expiredAt = run.expiredAt ? new Date(run.expiredAt) : null;
  const updatedAt = new Date(run.updatedAt);

  const isFinished = isFinalRunStatus(run.status);

  return (
    <div className="min-w-fit max-w-80">
      <RunTimelineEvent
        title="Triggered"
        subtitle={<DateTimeAccurate date={run.createdAt} />}
        state="complete"
      />
      {delayUntil && !expiredAt ? (
        <RunTimelineLine
          title={
            run.startedAt ? (
              <>{formatDuration(createdAt, delayUntil)} delay</>
            ) : (
              <span className="flex items-center gap-1">
                <ClockIcon className="size-4" />
                <span>
                  Delayed until <DateTime date={delayUntil} /> {run.ttl && <>(TTL {run.ttl})</>}
                </span>
              </span>
            )
          }
          state={run.startedAt ? "complete" : "delayed"}
        />
      ) : startedAt ? (
        <RunTimelineLine title={formatDuration(createdAt, startedAt)} state={"complete"} />
      ) : (
        <RunTimelineLine
          title={
            <>
              <LiveTimer startTime={createdAt} endTime={startedAt ?? expiredAt ?? undefined} />{" "}
              {run.ttl && <>(TTL {run.ttl})</>}
            </>
          }
          state={run.startedAt || run.expiredAt ? "complete" : "inprogress"}
        />
      )}
      {expiredAt ? (
        <RunTimelineEvent
          title="Expired"
          subtitle={<DateTimeAccurate date={expiredAt} />}
          state="error"
        />
      ) : startedAt ? (
        <>
          <RunTimelineEvent
            title="Started"
            subtitle={<DateTimeAccurate date={startedAt} />}
            state="complete"
          />
          {isFinished ? (
            <>
              <RunTimelineLine title={formatDuration(startedAt, updatedAt)} state={"complete"} />
              <RunTimelineEvent
                title="Finished"
                subtitle={<DateTimeAccurate date={updatedAt} />}
                state="complete"
              />
            </>
          ) : (
            <RunTimelineLine
              title={
                <span className="flex items-center gap-1">
                  <Spinner className="size-4" />
                  <span>
                    <LiveTimer startTime={startedAt} />
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
