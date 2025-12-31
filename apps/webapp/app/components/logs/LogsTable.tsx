import { ArrowPathIcon } from "@heroicons/react/20/solid";
import { Link } from "@remix-run/react";
import { formatDurationNanoseconds } from "@trigger.dev/core/v3";
import { type ReactNode, useEffect, useRef } from "react";
import { cn } from "~/utils/cn";
import { Button } from "~/components/primitives/Buttons";
import { useEnvironment } from "~/hooks/useEnvironment";
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
import type { LogEntry, LogsListAppliedFilters } from "~/presenters/v3/LogsListPresenter.server";
import { v3RunSpanPath } from "~/utils/pathBuilder";
import { DateTime } from "../primitives/DateTime";
import { Paragraph } from "../primitives/Paragraph";
import { Spinner } from "../primitives/Spinner";
import { SimpleTooltip } from "../primitives/Tooltip";
import {
  Table,
  TableBlankRow,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
  type TableVariant,
} from "../primitives/Table";

type LogsTableProps = {
  logs: LogEntry[];
  hasFilters: boolean;
  filters: LogsListAppliedFilters;
  searchTerm?: string;
  isLoading?: boolean;
  isLoadingMore?: boolean;
  hasMore?: boolean;
  onLoadMore?: () => void;
  variant?: TableVariant;
  selectedLogId?: string;
  onLogSelect?: (logId: string) => void;
};

// Level badge color styles
function getLevelColor(level: LogEntry["level"]): string {
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

// Left border color for error highlighting
function getLevelBorderColor(level: LogEntry["level"]): string {
  switch (level) {
    case "ERROR":
      return "border-l-error";
    case "WARN":
      return "border-l-warning";
    case "INFO":
      return "border-l-blue-500";
    case "DEBUG":
    case "TRACE":
    case "LOG":
    default:
      return "border-l-transparent hover:border-l-charcoal-800";
  }
}

// Case-insensitive text highlighting
function highlightText(text: string, searchTerm: string | undefined): ReactNode {
  if (!searchTerm || searchTerm.trim() === "") {
    return text;
  }

  const lowerText = text.toLowerCase();
  const lowerSearch = searchTerm.toLowerCase();
  const index = lowerText.indexOf(lowerSearch);

  if (index === -1) {
    return text;
  }

  return (
    <>
      {text.slice(0, index)}
      <mark className="rounded bg-yellow-500/30 px-0.5">
        {text.slice(index, index + searchTerm.length)}
      </mark>
      {text.slice(index + searchTerm.length)}
    </>
  );
}

export function LogsTable({
  logs,
  hasFilters,
  filters,
  searchTerm,
  isLoading = false,
  isLoadingMore = false,
  hasMore = false,
  onLoadMore,
  variant = "dimmed",
  selectedLogId,
  onLogSelect,
}: LogsTableProps) {
  const organization = useOrganization();
  const project = useProject();
  const environment = useEnvironment();
  const loadMoreRef = useRef<HTMLDivElement>(null);

  // Intersection observer for infinite scroll
  useEffect(() => {
    if (!hasMore || isLoadingMore || !onLoadMore) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting) {
          onLoadMore();
        }
      },
      { threshold: 0.1 }
    );

    const currentRef = loadMoreRef.current;
    if (currentRef) {
      observer.observe(currentRef);
    }

    return () => {
      if (currentRef) {
        observer.unobserve(currentRef);
      }
    };
  }, [hasMore, isLoadingMore, onLoadMore]);

  return (
    <div className="relative h-full overflow-y-auto scrollbar-thin scrollbar-track-transparent scrollbar-thumb-charcoal-600">
      <Table variant="compact/mono">
        <TableHeader>
          <TableRow>
            <TableHeaderCell>Time</TableHeaderCell>
            <TableHeaderCell>Run</TableHeaderCell>
            <TableHeaderCell>Task</TableHeaderCell>
            <TableHeaderCell>Level</TableHeaderCell>
            <TableHeaderCell>Status</TableHeaderCell>
            <TableHeaderCell>Duration</TableHeaderCell>
            <TableHeaderCell className="w-full">Message</TableHeaderCell>
          </TableRow>
        </TableHeader>
        <TableBody>
          {logs.length === 0 && !hasFilters ? (
            <TableBlankRow colSpan={7}>
              {!isLoading && <NoLogs title="No logs found" />}
            </TableBlankRow>
          ) : logs.length === 0 ? (
            <BlankState isLoading={isLoading} />
          ) : (
            logs.map((log) => {
              const isSelected = selectedLogId === log.id;
              const runPath = v3RunSpanPath(
                organization,
                project,
                environment,
                { friendlyId: log.runId },
                { spanId: log.spanId }
              );

              const handleRowClick = () => onLogSelect?.(log.id);

              return (
                <TableRow
                  key={log.id}
                  className={cn(
                    "cursor-pointer border-l-2 transition-colors",
                    getLevelBorderColor(log.level),
                    isSelected ? "bg-charcoal-750" : "hover:bg-charcoal-850"
                  )}
                  isSelected={isSelected}
                >
                  <TableCell
                    className="whitespace-nowrap tabular-nums"
                    onClick={handleRowClick}
                    hasAction
                  >
                    <DateTime date={log.startTime} />
                  </TableCell>
                  <TableCell>
                    <SimpleTooltip
                      content="Jump to run"
                      disableHoverableContent
                      button={
                        <Link
                          to={runPath}
                          className="flex items-center gap-1 text-blue-500 hover:text-blue-400"
                        >
                          {log.runId.slice(0, 12)}…
                        </Link>
                      }
                    />
                  </TableCell>
                  <TableCell onClick={handleRowClick} hasAction>
                    <span className="font-mono text-xs">{log.taskIdentifier}</span>
                  </TableCell>
                  <TableCell onClick={handleRowClick} hasAction>
                    <span
                      className={cn(
                        "inline-flex items-center rounded border px-1 py-0.5 text-xxs font-medium uppercase tracking-wider",
                        getLevelColor(log.level)
                      )}
                    >
                      {log.level}
                    </span>
                  </TableCell>
                  <TableCell onClick={handleRowClick} hasAction>
                    <span
                      className={cn(
                        "inline-flex items-center rounded border px-1 py-0.5 text-xxs font-medium uppercase tracking-wider",
                        getStatusColor(log.status)
                      )}
                    >
                      {log.status}
                    </span>
                  </TableCell>
                  <TableCell
                    className="whitespace-nowrap tabular-nums text-text-dimmed"
                    onClick={handleRowClick}
                    hasAction
                  >
                    {log.duration > 0
                      ? formatDurationNanoseconds(log.duration, { style: "short" })
                      : "–"}
                  </TableCell>
                  <TableCell className="max-w-0 truncate" onClick={handleRowClick} hasAction>
                    <span className="block truncate font-mono text-xs" title={log.message}>
                      {highlightText(log.message, searchTerm)}
                    </span>
                  </TableCell>
                </TableRow>
              );
            })
          )}
        </TableBody>
      </Table>
      {/* Infinite scroll trigger */}
      {hasMore && logs.length > 0 && (
        <div ref={loadMoreRef} className="flex items-center justify-center py-4">
          {isLoadingMore && (
            <div className="flex items-center gap-2">
              <Spinner /> <span className="text-text-dimmed">Loading more…</span>
            </div>
          )}
        </div>
      )}
      {isLoading && (
        <div className="absolute inset-0 flex items-center justify-center gap-2 bg-charcoal-900/90">
          <Spinner /> <span className="text-text-dimmed">Loading…</span>
        </div>
      )}
    </div>
  );
}

function NoLogs({ title }: { title: string }) {
  return (
    <div className="flex items-center justify-center">
      <Paragraph className="w-auto">{title}</Paragraph>
    </div>
  );
}

function BlankState({ isLoading }: { isLoading?: boolean }) {
  if (isLoading) return <TableBlankRow colSpan={7}></TableBlankRow>;

  return (
    <TableBlankRow colSpan={7}>
      <div className="flex flex-col items-center justify-center gap-6">
        <Paragraph className="w-auto" variant="base/bright">
          No logs match your filters. Try refreshing or modifying your filters.
        </Paragraph>
        <div className="flex items-center gap-2">
          <Button
            LeadingIcon={ArrowPathIcon}
            variant="tertiary/medium"
            onClick={() => {
              window.location.reload();
            }}
          >
            Refresh
          </Button>
        </div>
      </div>
    </TableBlankRow>
  );
}
