import { XMarkIcon, ArrowTopRightOnSquareIcon, ClockIcon } from "@heroicons/react/20/solid";
import { Link } from "@remix-run/react";
import { formatDurationNanoseconds } from "@trigger.dev/core/v3";
import { useEffect } from "react";
import { useTypedFetcher } from "remix-typedjson";
import { cn } from "~/utils/cn";
import { Button } from "~/components/primitives/Buttons";
import { DateTime } from "~/components/primitives/DateTime";
import { Header2, Header3 } from "~/components/primitives/Headers";
import { Paragraph } from "~/components/primitives/Paragraph";
import { Spinner } from "~/components/primitives/Spinner";
import { useEnvironment } from "~/hooks/useEnvironment";
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
import type { LogEntry } from "~/presenters/v3/LogsListPresenter.server";
import { v3RunSpanPath } from "~/utils/pathBuilder";
import type { loader as logDetailLoader } from "~/routes/resources.orgs.$organizationSlug.projects.$projectParam.env.$envParam.logs.$logId";

type LogDetailViewProps = {
  logId: string;
  // If we have the log entry from the list, we can display it immediately
  initialLog?: LogEntry;
  onClose: () => void;
};

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

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-4">
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
        {"rawMetadata" in log &&
          (log as { rawMetadata?: string }).rawMetadata &&
          (log as { rawMetadata?: string }).rawMetadata !== "{}" && (
            <div className="mb-6">
              <Header3 className="mb-2">Metadata</Header3>
              <div className="rounded-md border border-grid-dimmed bg-charcoal-850 p-3">
                <pre className="whitespace-pre-wrap break-words font-mono text-xs text-text-dimmed">
                  {JSON.stringify(
                    "metadata" in log
                      ? (log as { metadata: Record<string, unknown> }).metadata
                      : JSON.parse((log as { rawMetadata: string }).rawMetadata),
                    null,
                    2
                  )}
                </pre>
              </div>
            </div>
          )}

        {/* Attributes - only available in full log detail */}
        {"rawAttributes" in log &&
          (log as { rawAttributes?: string }).rawAttributes &&
          (log as { rawAttributes?: string }).rawAttributes !== "{}" && (
            <div className="mb-6">
              <Header3 className="mb-2">Attributes</Header3>
              <div className="rounded-md border border-grid-dimmed bg-charcoal-850 p-3">
                <pre className="whitespace-pre-wrap break-words font-mono text-xs text-text-dimmed">
                  {JSON.stringify(
                    "attributes" in log
                      ? (log as { attributes: Record<string, unknown> }).attributes
                      : JSON.parse((log as { rawAttributes: string }).rawAttributes),
                    null,
                    2
                  )}
                </pre>
              </div>
            </div>
          )}
      </div>
    </div>
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
