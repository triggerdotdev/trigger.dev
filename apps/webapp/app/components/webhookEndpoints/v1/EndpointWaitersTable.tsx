import { useFetcher } from "@remix-run/react";
import { PermissionButton } from "~/components/primitives/PermissionButton";
import { DateTime } from "~/components/primitives/DateTime";
import { Paragraph } from "~/components/primitives/Paragraph";
import { TruncatedCopyableValue } from "~/components/primitives/TruncatedCopyableValue";
import {
  Table,
  TableBlankRow,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
} from "~/components/primitives/Table";
import { useEnvironment } from "~/hooks/useEnvironment";
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
import { v3WaitpointTokenPath } from "~/utils/pathBuilder";

export type EndpointWaiters = {
  waiters: Array<{
    id: string;
    expiresAt: Date;
    match?: Record<string, string | number | boolean>;
    filter?: string;
  }>;
  total: number;
};

/**
 * Live webhook waiters on an endpoint, soonest expiry first. A waiter is a waitpoint, so each row
 * links to its waitpoint page (which shows the waiting run).
 */
export function EndpointWaitersTable({
  list,
  canCancel,
}: {
  list: EndpointWaiters | null;
  /** Whether the viewer has write:waitpoints here; cancelling fails the waiter's waitpoint. */
  canCancel: boolean;
}) {
  const organization = useOrganization();
  const project = useProject();
  const environment = useEnvironment();

  return (
    <Table showTopBorder={false} stickyHeader>
      <TableHeader>
        <TableRow>
          <TableHeaderCell>Waiter</TableHeaderCell>
          <TableHeaderCell>Match</TableHeaderCell>
          <TableHeaderCell>Filter</TableHeaderCell>
          <TableHeaderCell>Expires</TableHeaderCell>
          <TableHeaderCell>
            <span className="sr-only">Cancel</span>
          </TableHeaderCell>
        </TableRow>
      </TableHeader>
      <TableBody>
        {!list || list.waiters.length === 0 ? (
          <TableBlankRow colSpan={5}>
            <Paragraph variant="small" className="text-center">
              {list ? "No live waiters on this endpoint" : "Waiters aren't available"}
            </Paragraph>
          </TableBlankRow>
        ) : (
          list.waiters.map((waiter) => {
            const path = v3WaitpointTokenPath(organization, project, environment, {
              id: waiter.id,
            });
            return (
              <TableRow key={waiter.id}>
                <TableCell to={path}>
                  <TruncatedCopyableValue value={waiter.id} className="text-xs" />
                </TableCell>
                <TableCell to={path}>
                  <WaiterMatch match={waiter.match} />
                </TableCell>
                <TableCell to={path}>
                  {waiter.filter ? (
                    <code className="block max-w-xs whitespace-normal break-words text-xs text-text-bright">
                      {waiter.filter}
                    </code>
                  ) : (
                    <span className="text-text-dimmed">None</span>
                  )}
                </TableCell>
                <TableCell to={path}>
                  <DateTime date={waiter.expiresAt} />
                </TableCell>
                <TableCell alignment="right">
                  <CancelWaiterButton waiterId={waiter.id} canCancel={canCancel} />
                </TableCell>
              </TableRow>
            );
          })
        )}
        {list && list.total > list.waiters.length ? (
          <TableBlankRow colSpan={5}>
            <Paragraph variant="extra-small" className="text-center text-text-dimmed">
              Showing {list.waiters.length} of {list.total} live waiters
            </Paragraph>
          </TableBlankRow>
        ) : null}
      </TableBody>
    </Table>
  );
}

function WaiterMatch({ match }: { match: EndpointWaiters["waiters"][number]["match"] }) {
  const entries = Object.entries(match ?? {});
  if (entries.length === 0) {
    return <span className="text-text-dimmed">Its own URL</span>;
  }
  return (
    <span className="flex flex-col gap-0.5">
      {entries.map(([path, value]) => (
        <code
          key={path}
          className="max-w-sm whitespace-normal break-words text-xs text-text-bright"
        >
          {path} = {JSON.stringify(value)}
        </code>
      ))}
    </span>
  );
}

function CancelWaiterButton({ waiterId, canCancel }: { waiterId: string; canCancel: boolean }) {
  const fetcher = useFetcher();
  const isCancelling = fetcher.state !== "idle";
  return (
    <fetcher.Form method="post">
      <input type="hidden" name="intent" value="cancel-waiter" />
      <input type="hidden" name="waiterId" value={waiterId} />
      <PermissionButton
        hasPermission={canCancel}
        noPermissionTooltip="You don't have permission to cancel waiters."
        type="submit"
        variant="tertiary/small"
        disabled={isCancelling}
      >
        {isCancelling ? "Cancelling…" : "Cancel"}
      </PermissionButton>
    </fetcher.Form>
  );
}
