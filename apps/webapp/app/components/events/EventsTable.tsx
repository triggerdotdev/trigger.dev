import { StopIcon } from "@heroicons/react/24/outline";
import { CheckIcon } from "@heroicons/react/24/solid";
import { RuntimeEnvironmentType, User } from "@trigger.dev/database";
import { EnvironmentLabel } from "../environments/EnvironmentLabel";
import { DateTime } from "../primitives/DateTime";
import { Paragraph } from "../primitives/Paragraph";
import { Spinner } from "../primitives/Spinner";
import {
  Table,
  TableBlankRow,
  TableBody,
  TableCell,
  TableCellChevron,
  TableHeader,
  TableHeaderCell,
  TableRow,
} from "../primitives/Table";

type EventTableItem = {
  id: string;
  name: string | null;
  environment: {
    type: RuntimeEnvironmentType;
    userId?: string;
    userName?: string;
  };
  createdAt: Date | null;
  isTest: boolean;
  deliverAt: Date | null;
  deliveredAt: Date | null;
  cancelledAt: Date | null;
  runs: number;
};

type EventsTableProps = {
  total: number;
  hasFilters: boolean;
  events: EventTableItem[];
  isLoading?: boolean;
  eventsParentPath: string;
  currentUser: User;
};

export function EventsTable({
  total,
  hasFilters,
  events,
  isLoading = false,
  eventsParentPath,
  currentUser,
}: EventsTableProps) {
  return (
    <Table>
      <TableHeader>
        <TableHeaderCell>Event</TableHeaderCell>
        <TableHeaderCell>Env</TableHeaderCell>
        <TableHeaderCell>Received Time</TableHeaderCell>
        <TableHeaderCell>Delivery Time</TableHeaderCell>
        <TableHeaderCell>Delivered</TableHeaderCell>
        <TableHeaderCell>Canceled Time</TableHeaderCell>
        <TableHeaderCell>Test</TableHeaderCell>
        <TableHeaderCell>Runs</TableHeaderCell>
        <TableHeaderCell>
          <span className="sr-only">Go to page</span>
        </TableHeaderCell>
      </TableHeader>
      <TableBody>
        {total === 0 && !hasFilters ? (
          <TableBlankRow colSpan={9}>
            <NoEvents title="No events found" />
          </TableBlankRow>
        ) : events.length === 0 ? (
          <TableBlankRow colSpan={9}>
            <NoEvents title="No events match your filters" />
          </TableBlankRow>
        ) : (
          events.map((event) => {
            const path = `${eventsParentPath}/events/${event.id}`;
            const usernameForEnv =
              currentUser.id !== event.environment.userId ? event.environment.userName : undefined;

            return (
              <TableRow key={event.id}>
                <TableCell to={path}>{typeof event.name === "string" ? event.name : "-"}</TableCell>
                <TableCell to={path}>
                  <EnvironmentLabel environment={event.environment} userName={usernameForEnv} />
                </TableCell>
                <TableCell to={path}>
                  {event.createdAt ? <DateTime date={event.createdAt} /> : "–"}
                </TableCell>
                <TableCell to={path}>
                  {event.deliverAt ? <DateTime date={event.deliverAt} /> : "–"}
                </TableCell>
                <TableCell to={path}>
                  {event.deliveredAt ? <DateTime date={event.deliveredAt} /> : "–"}
                </TableCell>
                <TableCell to={path}>
                  {event.cancelledAt ? <DateTime date={event.cancelledAt} /> : "–"}
                </TableCell>
                <TableCell to={path}>
                  {event.isTest ? (
                    <CheckIcon className="h-4 w-4 text-charcoal-400" />
                  ) : (
                    <StopIcon className="h-4 w-4 text-charcoal-850" />
                  )}
                </TableCell>
                <TableCell to={path}>{event.runs}</TableCell>
                <TableCellChevron to={path} isSticky />
              </TableRow>
            );
          })
        )}
        {isLoading && (
          <TableBlankRow
            colSpan={8}
            className="absolute left-0 top-0 flex h-full w-full items-center justify-center gap-2 bg-charcoal-900/90"
          >
            <Spinner /> <span className="text-text-dimmed">Loading…</span>
          </TableBlankRow>
        )}
      </TableBody>
    </Table>
  );
}

function NoEvents({ title }: { title: string }) {
  return (
    <div className="flex items-center justify-center">
      <Paragraph className="w-auto">{title}</Paragraph>
    </div>
  );
}
