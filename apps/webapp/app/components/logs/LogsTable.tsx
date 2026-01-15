import { ArrowPathIcon, ArrowTopRightOnSquareIcon } from "@heroicons/react/20/solid";
import { useEffect, useRef, useState } from "react";
import { cn } from "~/utils/cn";
import { Button } from "~/components/primitives/Buttons";
import { useEnvironment } from "~/hooks/useEnvironment";
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
import type { LogEntry } from "~/presenters/v3/LogsListPresenter.server";
import { getLevelColor, highlightSearchText } from "~/utils/logUtils";
import { v3RunSpanPath } from "~/utils/pathBuilder";
import { DateTime } from "../primitives/DateTime";
import { Paragraph } from "../primitives/Paragraph";
import { Spinner } from "../primitives/Spinner";
import { TruncatedCopyableValue } from "../primitives/TruncatedCopyableValue";
import {
  Table,
  TableBlankRow,
  TableBody,
  TableCell,
  TableCellMenu,
  TableHeader,
  TableHeaderCell,
  TableRow,
  type TableVariant,
} from "../primitives/Table";
import { PopoverMenuItem } from "~/components/primitives/Popover";

type LogsTableProps = {
  logs: LogEntry[];
  searchTerm?: string;
  isLoading?: boolean;
  isLoadingMore?: boolean;
  hasMore?: boolean;
  onLoadMore?: () => void;
  variant?: TableVariant;
  selectedLogId?: string;
  onLogSelect?: (logId: string) => void;
};

// Left border color for error highlighting
function getLevelBorderColor(level: LogEntry["level"]): string {
  switch (level) {
    case "ERROR":
      return "border-l-error";
    case "WARN":
      return "border-l-warning";
    case "INFO":
      return "border-l-blue-500";
    case "CANCELLED":
      return "border-l-charcoal-600";
    case "DEBUG":
    case "TRACE":
    default:
      return "border-l-transparent hover:border-l-charcoal-800";
  }
}


export function LogsTable({
  logs,
  searchTerm,
  isLoading = false,
  isLoadingMore = false,
  hasMore = false,
  onLoadMore,
  selectedLogId,
  onLogSelect,
}: LogsTableProps) {
  const organization = useOrganization();
  const project = useProject();
  const environment = useEnvironment();
  const loadMoreRef = useRef<HTMLDivElement>(null);
  const [showLoadMoreSpinner, setShowLoadMoreSpinner] = useState(false);

  // Show load more spinner only after 0.2 seconds of loading time
  useEffect(() => {
    if (!isLoadingMore) {
      setShowLoadMoreSpinner(false);
      return;
    }

    const timer = setTimeout(() => {
      setShowLoadMoreSpinner(true);
    }, 200);

    return () => clearTimeout(timer);
  }, [isLoadingMore]);

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
    <div className="relative h-full overflow-auto scrollbar-thin scrollbar-track-transparent scrollbar-thumb-charcoal-600">
      <Table variant="compact/mono" containerClassName="overflow-visible">
        <TableHeader className="sticky top-0 z-10">
          <TableRow>
            <TableHeaderCell className="min-w-48 whitespace-nowrap">Time</TableHeaderCell>
            <TableHeaderCell className="min-w-24 whitespace-nowrap">Run</TableHeaderCell>
            <TableHeaderCell className="min-w-32 whitespace-nowrap">Task</TableHeaderCell>
            <TableHeaderCell className="min-w-24 whitespace-nowrap">Level</TableHeaderCell>
            <TableHeaderCell className="w-full min-w-0">Message</TableHeaderCell>
          </TableRow>
        </TableHeader>
        <TableBody>
          {logs.length === 0 ? (
            <BlankState isLoading={isLoading} onRefresh={() => window.location.reload()} />
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
                  <TableCell className="min-w-24">
                    <TruncatedCopyableValue value={log.runId} />
                  </TableCell>
                  <TableCell className="min-w-32" onClick={handleRowClick} hasAction>
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
                  <TableCell className="max-w-0 truncate" onClick={handleRowClick} hasAction>
                    <span className="block truncate font-mono text-xs" title={log.message}>
                      {highlightSearchText(log.message, searchTerm)}
                    </span>
                  </TableCell>
                  <TableCellMenu
                    className="pl-32"
                    hiddenButtons={
                      <PopoverMenuItem
                        openInNewTab={true}
                        to={runPath}
                        icon={ArrowTopRightOnSquareIcon}
                        title="View Run"
                      />
                    }
                  />
                </TableRow>
              );
            })
          )}
        </TableBody>
      </Table>
      {/* Infinite scroll trigger */}
      {hasMore && logs.length > 0 && (
        <div ref={loadMoreRef} className="flex items-center justify-center py-4">
          {showLoadMoreSpinner && (
            <div className="flex items-center gap-2">
              <Spinner /> <span className="text-text-dimmed">Loading more…</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function BlankState({ isLoading, onRefresh }: { isLoading?: boolean; onRefresh?: () => void }) {
  if (isLoading) return <TableBlankRow colSpan={6}></TableBlankRow>;

  const handleRefresh = onRefresh ?? (() => window.location.reload());

  return (
    <TableBlankRow colSpan={6}>
      <div className="flex flex-col items-center justify-center gap-6">
        <Paragraph className="w-auto" variant="base/bright">
          No logs match your filters. Try refreshing or modifying your filters.
        </Paragraph>
        <div className="flex items-center gap-2">
          <Button
            LeadingIcon={ArrowPathIcon}
            variant="tertiary/medium"
            onClick={handleRefresh}
          >
            Refresh
          </Button>
        </div>
      </div>
    </TableBlankRow>
  );
}
