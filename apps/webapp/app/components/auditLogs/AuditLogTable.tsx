import { ArrowPathIcon } from "@heroicons/react/20/solid";
import { type Dispatch, memo, type SetStateAction } from "react";
import { Button } from "~/components/primitives/Buttons";
import { DateTime } from "~/components/primitives/DateTime";
import { Spinner } from "~/components/primitives/Spinner";
import { Paragraph } from "~/components/primitives/Paragraph";
import {
  Table,
  TableBlankRow,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
} from "~/components/primitives/Table";
import type { AuditLogEventView } from "~/presenters/v3/AuditLogPresenter.server";
import { AuditLogActor, AuditLogAction, AuditLogTarget } from "./AuditLogParts";

/**
 * One event. Memoized, and `onSelect` is a state setter, which React keeps stable: "Load more" then
 * renders only the new rows, and a click only the rows whose selection changed.
 */
const AuditLogRow = memo(function AuditLogRow({
  event,
  isSelected,
  onSelect,
}: {
  event: AuditLogEventView;
  isSelected: boolean;
  onSelect: Dispatch<SetStateAction<string | undefined>>;
}) {
  // Clicking the selected row closes it.
  const select = () => onSelect((current) => (current === event.id ? undefined : event.id));
  return (
    <TableRow isSelected={isSelected}>
      <TableCell onClick={select} isTabbableCell>
        {/* The viewer's time, as elsewhere in the dashboard; UTC on hover and in the detail panel. */}
        <DateTime date={event.occurredAt} hour12={false} />
      </TableCell>
      <TableCell onClick={select}>
        <AuditLogActor actor={event.actor} />
      </TableCell>
      <TableCell onClick={select}>
        <AuditLogAction category={event.category} label={event.actionLabel} />
      </TableCell>
      <TableCell onClick={select}>
        <AuditLogTarget event={event} />
      </TableCell>
      <TableCell onClick={select}>
        <span className="text-text-dimmed">{event.client}</span>
      </TableCell>
    </TableRow>
  );
});

export function AuditLogTable({
  events,
  selectedId,
  onSelect,
  hasMore,
  isLoadingMore,
  loadMoreError,
  onLoadMore,
  isFiltered,
  isLoading = false,
}: {
  events: AuditLogEventView[];
  selectedId: string | undefined;
  /** The selection's state setter: stable, so a click re-renders only the rows it changes. */
  onSelect: Dispatch<SetStateAction<string | undefined>>;
  hasMore: boolean;
  isLoadingMore: boolean;
  loadMoreError: string | null;
  onLoadMore: () => void;
  isFiltered: boolean;
  /** A filter change is loading: the rows are covered, as on the runs list. */
  isLoading?: boolean;
}) {
  return (
    <>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHeaderCell>Time (Local)</TableHeaderCell>
            <TableHeaderCell>Actor</TableHeaderCell>
            <TableHeaderCell>Action</TableHeaderCell>
            <TableHeaderCell>Target</TableHeaderCell>
            <TableHeaderCell>Via</TableHeaderCell>
          </TableRow>
        </TableHeader>
        <TableBody>
          {events.length === 0 ? (
            // As on the logs page: what's missing, and a way to check again.
            <TableBlankRow colSpan={5}>
              <div className="flex flex-col items-center justify-center gap-6">
                <Paragraph className="w-auto" variant="base/bright">
                  {isFiltered
                    ? "No events match these filters. Try refreshing or changing the filters."
                    : "No events in this time range yet."}
                </Paragraph>
                <Button
                  LeadingIcon={ArrowPathIcon}
                  variant="tertiary/medium"
                  onClick={() => window.location.reload()}
                >
                  Refresh
                </Button>
              </div>
            </TableBlankRow>
          ) : (
            events.map((event) => (
              <AuditLogRow
                key={event.id}
                event={event}
                isSelected={event.id === selectedId}
                onSelect={onSelect}
              />
            ))
          )}
          {isLoading ? (
            <TableBlankRow
              colSpan={5}
              className="absolute left-0 top-0 flex h-full w-full items-center justify-center gap-2 bg-background-dimmed"
            >
              <Spinner /> <span className="text-text-dimmed">Loading…</span>
            </TableBlankRow>
          ) : null}
        </TableBody>
      </Table>
      {hasMore ? (
        <div className="flex items-center justify-center gap-2 py-3">
          <Paragraph variant="extra-small">{loadMoreError ?? `${events.length} events`}</Paragraph>
          <Button variant="secondary/small" onClick={onLoadMore} isLoading={isLoadingMore}>
            Load more
          </Button>
        </div>
      ) : null}
    </>
  );
}
