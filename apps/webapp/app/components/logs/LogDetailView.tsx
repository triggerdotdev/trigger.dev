import { XMarkIcon, ArrowTopRightOnSquareIcon, ClockIcon } from "@heroicons/react/20/solid";
import { Link } from "@remix-run/react";
import { formatDurationNanoseconds } from "@trigger.dev/core/v3";
import { useEffect, useState } from "react";
import { useTypedFetcher } from "remix-typedjson";
import { cn } from "~/utils/cn";
import { Button } from "~/components/primitives/Buttons";
import { DateTime } from "~/components/primitives/DateTime";
import { Header2, Header3 } from "~/components/primitives/Headers";
import { Paragraph } from "~/components/primitives/Paragraph";
import { Spinner } from "~/components/primitives/Spinner";
import { TabButton, TabContainer } from "~/components/primitives/Tabs";
import { useEnvironment } from "~/hooks/useEnvironment";
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
import type { LogEntry } from "~/presenters/v3/LogsListPresenter.server";
import { v3RunSpanPath } from "~/utils/pathBuilder";
import type { loader as logDetailLoader } from "~/routes/resources.orgs.$organizationSlug.projects.$projectParam.env.$envParam.logs.$logId";
import { TaskRunStatusCombo } from "~/components/runs/v3/TaskRunStatus";
import type { TaskRunStatus } from "@trigger.dev/database";

// Types for the run context endpoint response
type RunContextData = {
  run: {
    id: string;
    friendlyId: string;
    taskIdentifier: string;
    status: string;
    createdAt: string;
    startedAt?: string;
    completedAt?: string;
    isTest: boolean;
    tags: string[];
    queue: string;
    concurrencyKey: string | null;
    usageDurationMs: number;
    costInCents: number;
    baseCostInCents: number;
    machinePreset: string | null;
    version?: string;
    rootRun: { friendlyId: string; taskIdentifier: string } | null;
    parentRun: { friendlyId: string; taskIdentifier: string } | null;
    batch: { friendlyId: string } | null;
    schedule: { friendlyId: string } | null;
  } | null;
};


type LogDetailViewProps = {
  logId: string;
  // If we have the log entry from the list, we can display it immediately
  initialLog?: LogEntry;
  onClose: () => void;
};

type TabType = "details" | "run";

// Level badge color styles
function getLevelColor(level: string): string {
  switch (level) {
    case "ERROR":
      return "text-error bg-error/10 border-error/20";
    case "WARN":
      return "text-warning bg-warning/10 border-warning/20";
    case "DEBUG":
      return "text-charcoal-400 bg-charcoal-700 border-charcoal-600";
    case "INFO":
      return "text-blue-400 bg-blue-500/10 border-blue-500/20";
    case "TRACE":
      return "text-charcoal-500 bg-charcoal-800 border-charcoal-700";
    case "LOG":
    default:
      return "text-text-dimmed bg-charcoal-750 border-charcoal-700";
  }
}

// Event kind badge color styles
function getKindColor(kind: string): string {
  if (kind === "SPAN") {
    return "text-purple-400 bg-purple-500/10 border-purple-500/20";
  }
  if (kind === "SPAN_EVENT") {
    return "text-amber-400 bg-amber-500/10 border-amber-500/20";
  }
  if (kind.startsWith("LOG_")) {
    return "text-blue-400 bg-blue-500/10 border-blue-500/20";
  }
  return "text-charcoal-400 bg-charcoal-700 border-charcoal-600";
}

// Get human readable kind label
function getKindLabel(kind: string): string {
  switch (kind) {
    case "SPAN":
      return "Span";
    case "SPAN_EVENT":
      return "Event";
    case "LOG_DEBUG":
      return "Log";
    case "LOG_INFO":
      return "Log";
    case "LOG_WARN":
      return "Log";
    case "LOG_ERROR":
      return "Log";
    case "LOG_LOG":
      return "Log";
    case "DEBUG_EVENT":
      return "Debug";
    case "ANCESTOR_OVERRIDE":
      return "Override";
    default:
      return kind;
  }
}

// Status badge color styles
function getStatusColor(status: string): string {
  switch (status) {
    case "OK":
      return "text-success bg-success/10 border-success/20";
    case "ERROR":
      return "text-error bg-error/10 border-error/20";
    case "CANCELLED":
      return "text-charcoal-400 bg-charcoal-700 border-charcoal-600";
    case "PARTIAL":
      return "text-pending bg-pending/10 border-pending/20";
    default:
      return "text-text-dimmed bg-charcoal-750 border-charcoal-700";
  }
}

export function LogDetailView({ logId, initialLog, onClose }: LogDetailViewProps) {
  const organization = useOrganization();
  const project = useProject();
  const environment = useEnvironment();
  const fetcher = useTypedFetcher<typeof logDetailLoader>();
  const [activeTab, setActiveTab] = useState<TabType>("details");

  // Fetch full log details when logId changes
  useEffect(() => {
    if (!logId) return;

    fetcher.load(
      `/resources/orgs/${organization.slug}/projects/${project.slug}/env/${environment.slug}/logs/${encodeURIComponent(logId)}`
    );
  }, [organization.slug, project.slug, environment.slug, logId]);

  const isLoading = fetcher.state === "loading";
  const log = fetcher.data ?? initialLog;

  // Handle Escape key to close panel
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  if (isLoading && !log) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner />
      </div>
    );
  }

  if (!log) {
    return (
      <div className="flex h-full flex-col">
        <div className="flex items-center justify-between border-b border-grid-dimmed p-4">
          <Header2>Log Details</Header2>
          <Button variant="minimal/small" onClick={onClose}>
            <XMarkIcon className="size-5" />
          </Button>
        </div>
        <div className="flex flex-1 items-center justify-center">
          <Paragraph className="text-text-dimmed">Log not found</Paragraph>
        </div>
      </div>
    );
  }

  const runPath = v3RunSpanPath(
    organization,
    project,
    environment,
    { friendlyId: log.runId },
    { spanId: log.spanId }
  );

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-grid-dimmed px-4 py-3">
        <div className="flex items-center gap-2">
          <span
            className={cn(
              "inline-flex items-center rounded border px-1.5 py-0.5 text-xs font-medium",
              getKindColor(log.kind)
            )}
          >
            {getKindLabel(log.kind)}
          </span>
          <span
            className={cn(
              "inline-flex items-center rounded border px-1.5 py-0.5 text-xs font-medium uppercase",
              getLevelColor(log.level)
            )}
          >
            {log.level}
          </span>
          <span className="text-text-dimmed">·</span>
          <DateTime date={log.startTime} />
        </div>
        <Button variant="minimal/small" onClick={onClose} shortcut={{ key: "esc" }}>
          <XMarkIcon className="size-5" />
        </Button>
      </div>

      {/* Tabs */}
      <div className="border-b border-grid-dimmed px-4">
        <TabContainer>
          <TabButton
            isActive={activeTab === "details"}
            layoutId="log-detail-tabs"
            onClick={() => setActiveTab("details")}
            shortcut={{ key: "d" }}
          >
            Details
          </TabButton>
          <TabButton
            isActive={activeTab === "run"}
            layoutId="log-detail-tabs"
            onClick={() => setActiveTab("run")}
            shortcut={{ key: "r" }}
          >
            Run
          </TabButton>
        </TabContainer>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-4">
        {activeTab === "details" && (
          <DetailsTab log={log} runPath={runPath} />
        )}
        {activeTab === "run" && (
          <RunTab log={log} runPath={runPath} />
        )}
      </div>
    </div>
  );
}

function DetailsTab({ log, runPath }: { log: LogEntry; runPath: string }) {
  // Extract metadata and attributes - handle both parsed and raw string forms
  const logWithExtras = log as LogEntry & {
    metadata?: Record<string, unknown>;
    rawMetadata?: string;
    attributes?: Record<string, unknown>;
    rawAttributes?: string;
  };

  // Get raw strings for display
  const rawMetadata = logWithExtras.rawMetadata;
  const rawAttributes = logWithExtras.rawAttributes;

  // Parse metadata
  let metadata: Record<string, unknown> | null = null;
  if (logWithExtras.metadata) {
    metadata = logWithExtras.metadata;
  } else if (rawMetadata) {
    try {
      metadata = JSON.parse(rawMetadata) as Record<string, unknown>;
    } catch {
      // Ignore parse errors
    }
  }

  // Parse attributes
  let attributes: Record<string, unknown> | null = null;
  if (logWithExtras.attributes) {
    attributes = logWithExtras.attributes;
  } else if (rawAttributes) {
    try {
      attributes = JSON.parse(rawAttributes) as Record<string, unknown>;
    } catch {
      // Ignore parse errors
    }
  }

  // Extract error info from metadata
  const errorInfo = metadata?.error as { message?: string; attributes?: Record<string, unknown> } | undefined;

  // Check if we should show metadata/attributes sections
  const showMetadata = rawMetadata && rawMetadata !== "{}";
  const showAttributes = rawAttributes && rawAttributes !== "{}";

  return (
    <>
      {/* Error Details - show prominently for error status */}
      {errorInfo && (
        <div className="mb-6">
          <Header3 className="mb-2 text-error">Error Details</Header3>
          <div className="rounded-md border border-error/30 bg-error/5 p-3">
            {errorInfo.message && (
              <pre className="mb-3 whitespace-pre-wrap break-words font-mono text-sm text-error">
                {errorInfo.message}
              </pre>
            )}
            {errorInfo.attributes && Object.keys(errorInfo.attributes).length > 0 && (
              <div className="border-t border-error/20 pt-3">
                <Paragraph variant="extra-small" className="mb-2 text-text-dimmed">
                  Error Attributes
                </Paragraph>
                <pre className="whitespace-pre-wrap break-words font-mono text-xs text-text-bright">
                  {JSON.stringify(errorInfo.attributes, null, 2)}
                </pre>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Message */}
      <div className="mb-6">
        <Header3 className="mb-2">Message</Header3>
        <div className="rounded-md border border-grid-dimmed bg-charcoal-850 p-3">
          <pre className="whitespace-pre-wrap break-words font-mono text-sm text-text-bright">
            {log.message}
          </pre>
        </div>
      </div>

      {/* Run Link */}
      <div className="mb-6">
        <Header3 className="mb-2">Run</Header3>
        <div className="flex items-center gap-3">
          <span className="font-mono text-sm text-text-bright">{log.runId}</span>
          <Link
            to={runPath}
            target="_blank"
            rel="noopener noreferrer"
          >
            <Button variant="tertiary/small" LeadingIcon={ArrowTopRightOnSquareIcon}>
              View in Run
            </Button>
          </Link>
        </div>
      </div>

      {/* Details Grid */}
      <div className="mb-6">
        <Header3 className="mb-2">Details</Header3>
        <div className="grid grid-cols-2 gap-4 rounded-md border border-grid-dimmed bg-charcoal-850 p-3">
          <DetailItem label="Task" value={log.taskIdentifier} mono />
          <DetailItem label="Kind" value={log.kind} />
          <DetailItem label="Status" value={log.status} />
          <DetailItem
            label="Duration"
            value={
              log.duration > 0
                ? formatDurationNanoseconds(log.duration, { style: "short" })
                : "–"
            }
            icon={<ClockIcon className="size-4 text-text-dimmed" />}
          />
          <DetailItem label="Trace ID" value={log.traceId} mono small />
          <DetailItem label="Span ID" value={log.spanId} mono small />
          {log.parentSpanId && (
            <DetailItem label="Parent Span ID" value={log.parentSpanId} mono small />
          )}
        </div>
      </div>

      {/* Metadata - only available in full log detail */}
      {showMetadata && metadata && (
        <div className="mb-6">
          <Header3 className="mb-2">Metadata</Header3>
          <div className="rounded-md border border-grid-dimmed bg-charcoal-850 p-3">
            <pre className="whitespace-pre-wrap break-words font-mono text-xs text-text-dimmed">
              {JSON.stringify(metadata, null, 2)}
            </pre>
          </div>
        </div>
      )}

      {/* Attributes - only available in full log detail */}
      {showAttributes && attributes && (
        <div className="mb-6">
          <Header3 className="mb-2">Attributes</Header3>
          <div className="rounded-md border border-grid-dimmed bg-charcoal-850 p-3">
            <pre className="whitespace-pre-wrap break-words font-mono text-xs text-text-dimmed">
              {JSON.stringify(attributes, null, 2)}
            </pre>
          </div>
        </div>
      )}
    </>
  );
}

function RunTab({ log, runPath }: { log: LogEntry; runPath: string }) {
  const organization = useOrganization();
  const project = useProject();
  const environment = useEnvironment();
  const fetcher = useTypedFetcher<RunContextData>();

  // Fetch run details when tab is active
  useEffect(() => {
    if (!log.runId) return;

    fetcher.load(
      `/resources/orgs/${organization.slug}/projects/${project.slug}/env/${environment.slug}/logs/${encodeURIComponent(log.id)}/run?runId=${encodeURIComponent(log.runId)}`
    );
  }, [organization.slug, project.slug, environment.slug, log.id, log.runId]);

  const isLoading = fetcher.state === "loading";
  const runData = fetcher.data?.run;

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-8">
        <Spinner />
      </div>
    );
  }

  if (!runData) {
    return (
      <>
        <div className="mb-6">
          <Header3 className="mb-2">Run Information</Header3>
          <div className="rounded-md border border-grid-dimmed bg-charcoal-850 p-4">
            <Paragraph className="text-text-dimmed">Run not found in database.</Paragraph>
            <div className="mt-4 pt-4 border-t border-grid-dimmed">
              <Link to={runPath} target="_blank" rel="noopener noreferrer">
                <Button variant="primary/small" LeadingIcon={ArrowTopRightOnSquareIcon} fullWidth>
                  Try View in Run Page
                </Button>
              </Link>
            </div>
          </div>
        </div>
      </>
    );
  }

  return (
    <>
      <div className="mb-6">
        <Header3 className="mb-2">Run Information</Header3>
        <div className="rounded-md border border-grid-dimmed bg-charcoal-850 p-4">
          {/* Status and Task */}
          <div className="flex items-center gap-3 mb-4">
            <TaskRunStatusCombo status={runData.status as TaskRunStatus} />
            <span className="font-mono text-sm text-text-bright">{runData.taskIdentifier}</span>
          </div>

          {/* Details Grid */}
          <div className="grid grid-cols-2 gap-4 mb-4">
            <DetailItem label="Run ID" value={runData.friendlyId} mono />
            <DetailItem label="Version" value={runData.version ?? "–"} />
            <DetailItem label="Created" value={new Date(runData.createdAt).toLocaleString()} />
            {runData.startedAt && (
              <DetailItem label="Started" value={new Date(runData.startedAt).toLocaleString()} />
            )}
            {runData.completedAt && (
              <DetailItem label="Completed" value={new Date(runData.completedAt).toLocaleString()} />
            )}
            <DetailItem label="Queue" value={runData.queue} mono />
            {runData.machinePreset && (
              <DetailItem label="Machine" value={runData.machinePreset} />
            )}
            {runData.isTest && (
              <DetailItem label="Test Run" value="Yes" />
            )}
          </div>

          {/* Tags */}
          {runData.tags && runData.tags.length > 0 && (
            <div className="mb-4">
              <Paragraph variant="extra-small" className="mb-1 text-text-dimmed">
                Tags
              </Paragraph>
              <div className="flex flex-wrap gap-1">
                {runData.tags.map((tag: string) => (
                  <span
                    key={tag}
                    className="inline-flex items-center rounded bg-charcoal-700 px-2 py-0.5 text-xs text-text-bright"
                  >
                    {tag}
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* Relationships */}
          {(runData.parentRun || runData.rootRun || runData.batch || runData.schedule) && (
            <div className="mb-4 pt-4 border-t border-grid-dimmed">
              <Paragraph variant="extra-small" className="mb-2 text-text-dimmed">
                Relationships
              </Paragraph>
              <div className="grid grid-cols-2 gap-2">
                {runData.parentRun && (
                  <DetailItem
                    label="Parent Run"
                    value={`${runData.parentRun.taskIdentifier} (${runData.parentRun.friendlyId})`}
                    small
                  />
                )}
                {runData.rootRun && (
                  <DetailItem
                    label="Root Run"
                    value={`${runData.rootRun.taskIdentifier} (${runData.rootRun.friendlyId})`}
                    small
                  />
                )}
                {runData.batch && (
                  <DetailItem label="Batch" value={runData.batch.friendlyId} mono small />
                )}
                {runData.schedule && (
                  <DetailItem label="Schedule" value={runData.schedule.friendlyId} mono small />
                )}
              </div>
            </div>
          )}

          <div className="mt-4 pt-4 border-t border-grid-dimmed">
            <Link to={runPath} target="_blank" rel="noopener noreferrer">
              <Button variant="primary/small" LeadingIcon={ArrowTopRightOnSquareIcon} fullWidth>
                View Full Run Details
              </Button>
            </Link>
          </div>
        </div>
      </div>
    </>
  );
}

function DetailItem({
  label,
  value,
  mono = false,
  small = false,
  icon,
}: {
  label: string;
  value: string;
  mono?: boolean;
  small?: boolean;
  icon?: React.ReactNode;
}) {
  return (
    <div>
      <Paragraph variant="extra-small" className="mb-1 text-text-dimmed">
        {label}
      </Paragraph>
      <div className="flex items-center gap-1">
        {icon}
        <span
          className={cn(
            "text-text-bright",
            mono && "font-mono",
            small ? "text-xs" : "text-sm"
          )}
        >
          {value}
        </span>
      </div>
    </div>
  );
}
