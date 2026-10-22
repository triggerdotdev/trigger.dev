import {
  ArrowPathIcon,
  BookOpenIcon,
  CheckIcon,
  ChevronUpIcon,
  ClipboardDocumentIcon,
  ClockIcon,
  CloudArrowDownIcon,
  KeyIcon,
  QueueListIcon,
  SignalIcon,
} from "@heroicons/react/20/solid";
import { formatDurationMilliseconds } from "@trigger.dev/core/v3";
import { ExitIcon } from "~/assets/icons/ExitIcon";
import { GlobeLinesIcon } from "~/assets/icons/GlobeLinesIcon";
import { CodeBlock } from "~/components/code/CodeBlock";
import { EnvironmentCombo } from "~/components/environments/EnvironmentLabel";
import { MachineLabelCombo } from "~/components/MachineLabelCombo";
import { MachineTooltipInfo } from "~/components/MachineTooltipInfo";
import { Button, LinkButton } from "~/components/primitives/Buttons";
import { Callout } from "~/components/primitives/Callout";
import { CopyableText } from "~/components/primitives/CopyableText";
import { CopyTextLink } from "~/components/primitives/CopyTextLink";
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
import { TruncatedCopyableValue } from "~/components/primitives/TruncatedCopyableValue";
import { RunTimeline, RunTimelineEvent, SpanTimeline } from "~/components/run/RunTimeline";
import { PacketDisplay } from "~/components/runs/v3/PacketDisplay";
import { RegionLabel } from "~/components/runs/v3/RegionLabel";
import { RunError } from "~/components/runs/v3/RunError";
import { RunIcon } from "~/components/runs/v3/RunIcon";
import { RunTag } from "~/components/runs/v3/RunTag";
import { SpanEvents } from "~/components/runs/v3/SpanEvents";
import { SpanTitle } from "~/components/runs/v3/SpanTitle";
import { TaskRunAttemptStatusCombo } from "~/components/runs/v3/TaskRunAttemptStatus";
import {
  descriptionForTaskRunStatus,
  TaskRunStatusCombo,
} from "~/components/runs/v3/TaskRunStatus";
import { RuntimeIcon } from "~/components/RuntimeIcon";
import { cn } from "~/utils/cn";
import { formatCurrencyAccurate } from "~/utils/numberFormatter";
import {
  docsPath,
  v3BatchPath,
  v3DeploymentVersionPath,
  v3RunDownloadLogsPath,
  v3RunSpanPath,
  v3RunsPath,
} from "~/utils/pathBuilder";
import { createTimelineSpanEventsFromSpanEvents } from "~/utils/timelineSpanEvents";
import {
  mockEnvironment as environment,
  mockOrganization as organization,
  mockProject as project,
  type MockRunDetails,
  type MockSpanDetails,
  type MockSpanEntry,
} from "./mockTrace";

// The right-hand inspector, forked from SpanView in
// resources.orgs.$organizationSlug.projects.$projectParam.env.$envParam.runs.$runParam.spans.$spanParam.
// It renders mock data instead of loading the span, and leaves out the admin-only sections and
// the agent buttons, which render nothing for orgs without the agent.

export function SpanInspector({
  entry,
  runParam,
  tab,
  onTabChange,
  closePanel,
}: {
  entry: MockSpanEntry;
  runParam: string;
  tab: string | undefined;
  onTabChange: (tab: string) => void;
  closePanel: () => void;
}) {
  switch (entry.type) {
    case "run": {
      return (
        <RunBody
          run={entry.run}
          runParam={runParam}
          tab={tab}
          onTabChange={onTabChange}
          closePanel={closePanel}
        />
      );
    }
    case "span": {
      return <SpanBody span={entry.span} closePanel={closePanel} />;
    }
  }
}

function ClosePanelButton({ onClick }: { onClick: () => void }) {
  return (
    <Button
      onClick={onClick}
      variant="minimal/small"
      TrailingIcon={ExitIcon}
      shortcut={{ key: "esc" }}
      shortcutPosition="before-trailing-icon"
      className="pl-1"
    />
  );
}

function SpanBody({ span, closePanel }: { span: MockSpanDetails; closePanel: () => void }) {
  return (
    <div className="grid h-full max-h-full grid-rows-[2.5rem_1fr] overflow-hidden bg-background-bright">
      <div className="border-b border-grid-bright px-3 pr-2">
        <div className="grid h-10 grid-cols-[minmax(0,1fr)_auto] items-center gap-2">
          <div className="flex min-w-0 items-center gap-1">
            <RunIcon
              name={span.style?.icon}
              spanName={span.message}
              className="size-5 min-h-5 min-w-5"
            />
            <Header2 className="min-w-0">
              <SpanTitle {...span} size="large" hideAccessory overrideDimmed />
            </Header2>
          </div>
          <ClosePanelButton onClick={closePanel} />
        </div>
      </div>
      <div className="scrollbar-gutter-stable overflow-y-auto scrollbar-thin scrollbar-track-transparent scrollbar-thumb-surface-control">
        <SpanEntity span={span} />
      </div>
    </div>
  );
}

function RunBody({
  run,
  runParam,
  tab,
  onTabChange,
  closePanel,
}: {
  run: MockRunDetails;
  runParam: string;
  tab: string | undefined;
  onTabChange: (tab: string) => void;
  closePanel: () => void;
}) {
  return (
    <div className="grid h-full max-h-full grid-rows-[2.5rem_2rem_1fr_minmax(3.25rem,auto)] overflow-hidden bg-background-bright">
      <div className="flex items-center justify-between gap-2 overflow-x-hidden px-3 pr-2">
        <div className="flex items-center gap-1 overflow-x-hidden">
          <RunIcon name="task" spanName={run.taskIdentifier} className="size-5 min-h-5 min-w-5" />
          <Header2
            className={cn(
              "overflow-x-hidden",
              // The run-type accents are drawn for 3:1 as icons; as 16px text the
              // tasks blue falls under 4.5:1 on the light themes, so the title
              // takes the text colour there and the icon carries type.
              "text-tasks",
              "light:text-text-bright"
            )}
          >
            <span className="truncate">{run.taskIdentifier}</span>
          </Header2>
        </div>
        <ClosePanelButton onClick={closePanel} />
      </div>
      <div className="h-fit overflow-x-auto px-3 scrollbar-thin scrollbar-track-transparent scrollbar-thumb-surface-control">
        <TabContainer>
          <TabButton
            isActive={!tab || tab === "overview"}
            layoutId="span-run"
            onClick={() => onTabChange("overview")}
            shortcut={{ key: "o" }}
          >
            Overview
          </TabButton>
          <TabButton
            isActive={tab === "detail"}
            layoutId="span-run"
            onClick={() => onTabChange("detail")}
            shortcut={{ key: "d" }}
          >
            Detail
          </TabButton>
          <TabButton
            isActive={tab === "context"}
            layoutId="span-run"
            onClick={() => onTabChange("context")}
            shortcut={{ key: "x" }}
          >
            Context
          </TabButton>
          <TabButton
            isActive={tab === "metadata"}
            layoutId="span-run"
            onClick={() => onTabChange("metadata")}
            shortcut={{ key: "m" }}
          >
            Metadata
          </TabButton>
        </TabContainer>
      </div>
      <div className="overflow-y-auto px-3 scrollbar-thin scrollbar-track-transparent scrollbar-thumb-surface-control">
        <div>
          {tab === "detail" ? (
            <RunDetailTab run={run} />
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

              {run.error && (
                <div className="flex flex-col gap-2">
                  <RunError error={run.error} />
                </div>
              )}

              <PacketDisplay data={run.payload} dataType={run.payloadType} title="Payload" />

              {run.error === undefined && run.output !== undefined ? (
                <PacketDisplay data={run.output} dataType={run.outputType} title="Output" />
              ) : null}
            </div>
          )}
        </div>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-grid-dimmed px-2 py-2">
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
              Focus on run
            </LinkButton>
          )}
        </div>
        <div className="flex items-center">
          <Popover>
            <PopoverTrigger asChild>
              <Button
                variant="secondary/medium"
                LeadingIcon={CloudArrowDownIcon}
                leadingIconClassName="text-indigo-400"
                TrailingIcon={ChevronUpIcon}
              >
                Export trace
              </Button>
            </PopoverTrigger>
            <PopoverContent className="min-w-[180px] p-1" align="end">
              <TraceExportMenuItems runParam={runParam} />
            </PopoverContent>
          </Popover>
        </div>
      </div>
    </div>
  );
}

function RunDetailTab({ run }: { run: MockRunDetails }) {
  const { root, parent } = run.relationships;

  return (
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
            <TextLink
              to={v3RunsPath(organization, project, environment, {
                tasks: [run.taskIdentifier],
              })}
              tooltip={`View runs filtered by ${run.taskIdentifier}`}
            >
              <CopyableText value={run.taskIdentifier} copyValue={run.taskIdentifier} asChild />
            </TextLink>
          </Property.Value>
        </Property.Item>
        <Property.Item>
          <Property.Label>Run ID</Property.Label>
          <Property.Value>
            <CopyableText value={run.friendlyId} copyValue={run.friendlyId} asChild />
          </Property.Value>
        </Property.Item>
        {root ? (
          root.isParent ? (
            <Property.Item>
              <Property.Label>Root & Parent run</Property.Label>
              <Property.Value>
                <RelatedRunLink run={root} tooltip="Jump to root/parent run" />
              </Property.Value>
            </Property.Item>
          ) : (
            <>
              <Property.Item>
                <Property.Label>Root run</Property.Label>
                <Property.Value>
                  <RelatedRunLink run={root} tooltip="Jump to root run" />
                </Property.Value>
              </Property.Item>
              {parent ? (
                <Property.Item>
                  <Property.Label>Parent run</Property.Label>
                  <Property.Value>
                    <RelatedRunLink run={parent} tooltip="Jump to parent run" />
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
              <TextLink
                to={v3BatchPath(organization, project, environment, run.batch)}
                tooltip={`View batches filtered by ${run.batch.friendlyId}`}
              >
                <CopyableText
                  value={run.batch.friendlyId}
                  copyValue={run.batch.friendlyId}
                  asChild
                />
              </TextLink>
            </Property.Value>
          </Property.Item>
        )}
        <Property.Item>
          <Property.Label>
            <div className="flex items-center justify-between">
              <span className="flex items-center gap-1">
                Idempotency
                <InfoIconTooltip content={<IdempotencyTooltipContent />} />
              </span>
              {run.idempotencyKeyStatus === "active" ? (
                <Button type="button" variant="minimal/small" LeadingIcon={ArrowPathIcon}>
                  Reset
                </Button>
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
          <Property.Value>–</Property.Value>
        </Property.Item>
        <Property.Item>
          <Property.Label>Version</Property.Label>
          <Property.Value>
            <TextLink
              to={v3DeploymentVersionPath(organization, project, environment, run.version)}
              className="group flex flex-wrap items-center gap-x-1 gap-y-0"
              tooltip="Jump to deployment"
            >
              <CopyableText value={run.version} copyValue={run.version} asChild />
            </TextLink>
          </Property.Value>
        </Property.Item>
        <Property.Item>
          <Property.Label>External deployment ID</Property.Label>
          <Property.Value>–</Property.Value>
        </Property.Item>
        <Property.Item>
          <Property.Label>SDK version</Property.Label>
          <Property.Value>{run.sdkVersion}</Property.Value>
        </Property.Item>
        <Property.Item>
          <Property.Label>Runtime</Property.Label>
          <Property.Value>
            <RuntimeIcon runtime={run.runtime} runtimeVersion={run.runtimeVersion} withLabel />
          </Property.Value>
        </Property.Item>
        <Property.Item>
          <Property.Label>Test run</Property.Label>
          <Property.Value>
            {run.isTest ? <CheckIcon className="size-4 text-text-dimmed" /> : "–"}
          </Property.Value>
        </Property.Item>
        <Property.Item>
          <Property.Label>Environment</Property.Label>
          <Property.Value>
            <EnvironmentCombo environment={environment} />
          </Property.Value>
        </Property.Item>
        <Property.Item>
          <Property.Label>Queue</Property.Label>
          <Property.Value>
            <div>Name: {run.queue.name}</div>
            <div>Concurrency key: {run.queue.concurrencyKey ?? "–"}</div>
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
            {`${run.maxDurationInSeconds}s (${formatDurationMilliseconds(
              run.maxDurationInSeconds * 1000,
              { style: "short" }
            )})`}
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
        <Property.Item>
          <Property.Label>Region</Property.Label>
          <Property.Value>
            <RegionLabel region={run.region} />
          </Property.Value>
        </Property.Item>
        <Property.Item>
          <Property.Label>Run invocation cost</Property.Label>
          <Property.Value>{formatCurrencyAccurate(run.baseCostInCents / 100)}</Property.Value>
        </Property.Item>
        <Property.Item>
          <Property.Label>Compute cost</Property.Label>
          <Property.Value>{formatCurrencyAccurate(run.costInCents / 100)}</Property.Value>
        </Property.Item>
        <Property.Item>
          <Property.Label>Total cost</Property.Label>
          <Property.Value>
            {formatCurrencyAccurate((run.baseCostInCents + run.costInCents) / 100)}
          </Property.Value>
        </Property.Item>
        <Property.Item>
          <Property.Label>Usage duration</Property.Label>
          <Property.Value>
            {formatDurationMilliseconds(run.usageDurationMs, { style: "short" })}
          </Property.Value>
        </Property.Item>
        <Property.Item>
          <Property.Label>Run Engine</Property.Label>
          <Property.Value>{run.engine}</Property.Value>
        </Property.Item>
      </Property.Table>
    </div>
  );
}

function RelatedRunLink({
  run,
  tooltip,
}: {
  run: { taskIdentifier: string; friendlyId: string; spanId: string };
  tooltip: string;
}) {
  return (
    <TextLink
      to={v3RunSpanPath(
        organization,
        project,
        environment,
        { friendlyId: run.friendlyId },
        { spanId: run.spanId }
      )}
      className="group flex flex-wrap items-center gap-x-1 gap-y-0"
      tooltip={tooltip}
    >
      <CopyableText value={run.taskIdentifier} copyValue={run.taskIdentifier} asChild />
      <span className="break-all text-text-dimmed transition-colors group-hover:text-text-bright/80">
        <CopyableText value={run.friendlyId} copyValue={run.friendlyId} asChild />
      </span>
    </TextLink>
  );
}

function IdempotencyTooltipContent() {
  return (
    <div className="flex max-w-xs flex-col gap-3 p-1 pb-2">
      <div>
        <div className="mb-0.5 flex items-center gap-1.5">
          <KeyIcon className="size-4 text-text-dimmed" />
          <Header3>Idempotency keys</Header3>
        </div>
        <Paragraph variant="small" className="text-wrap! text-text-dimmed">
          Prevent duplicate task runs. If you trigger a task with the same key twice, the second
          request returns the original run.
        </Paragraph>
      </div>
      <div>
        <div className="mb-1 flex items-center gap-1">
          <GlobeLinesIcon className="size-4 text-blue-500" />
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
      <LinkButton to={docsPath("idempotency")} variant="docs/small" LeadingIcon={BookOpenIcon}>
        Read docs
      </LinkButton>
    </div>
  );
}

function TraceExportMenuItems({ runParam }: { runParam: string }) {
  const downloadPath = v3RunDownloadLogsPath({ friendlyId: runParam });

  return (
    <>
      <PopoverMenuItem
        title="Copy for AI"
        icon={ClipboardDocumentIcon}
        leadingIconClassName="text-emerald-500"
      />
      <PopoverMenuItem
        to={`${downloadPath}?format=markdown`}
        title="Download · Markdown"
        icon={CloudArrowDownIcon}
        leadingIconClassName="text-indigo-500"
        openInNewTab
      />
      <PopoverMenuItem
        to={`${downloadPath}?format=log`}
        title="Download · Log"
        icon={CloudArrowDownIcon}
        leadingIconClassName="text-indigo-500"
        openInNewTab
      />
      <PopoverMenuItem
        to={`${downloadPath}?format=jsonl`}
        title="Download · JSON Lines"
        icon={CloudArrowDownIcon}
        leadingIconClassName="text-indigo-500"
        openInNewTab
      />
    </>
  );
}

// Every scenario span is a plain span (attempts included, as on the real page): no waitpoint,
// stream or AI entity to render.
function SpanEntity({ span }: { span: MockSpanDetails }) {
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
            events={createTimelineSpanEventsFromSpanEvents(span.events, false)}
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
          <Property.Label className="flex items-center justify-between">
            <span>Message</span>
            <CopyTextLink value={span.message} />
          </Property.Label>
          <Property.Value className="whitespace-pre-wrap wrap-break-word">
            {span.message}
          </Property.Value>
        </Property.Item>
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
      {span.triggeredRuns.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <Header3>Runs</Header3>
          <Table containerClassName="max-h-50">
            <TableHeader className="bg-background-bright">
              <TableRow>
                <TableHeaderCell>ID</TableHeaderCell>
                <TableHeaderCell>Task</TableHeaderCell>
                <TableHeaderCell>Status</TableHeaderCell>
                <TableHeaderCell>Created</TableHeaderCell>
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
                      <TruncatedCopyableValue value={run.friendlyId} />
                    </TableCell>
                    <TableCell to={path} actionClassName="py-1.5" rowHoverStyle="bright">
                      {run.taskIdentifier}
                    </TableCell>
                    <TableCell to={path} actionClassName="py-1.5" rowHoverStyle="bright">
                      <TaskRunStatusCombo status={run.status} />
                    </TableCell>
                    <TableCell to={path} actionClassName="py-1.5" rowHoverStyle="bright">
                      <DateTimeAccurate date={run.createdAt} hour12={false} hideDate={true} />
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}
