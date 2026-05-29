import { ArrowRightIcon } from "@heroicons/react/20/solid";
import { useLocation, useNavigation } from "@remix-run/react";
import { formatDuration } from "@trigger.dev/core/v3/utils/durations";
import { ListBulletIcon } from "~/assets/icons/ListBulletIcon";
import { MiddleTruncate } from "~/components/primitives/MiddleTruncate";
import { DateTime } from "~/components/primitives/DateTime";
import { Paragraph } from "~/components/primitives/Paragraph";
import { PopoverMenuItem } from "~/components/primitives/Popover";
import { Spinner } from "~/components/primitives/Spinner";
import {
  Table,
  TableBlankRow,
  TableBody,
  TableCell,
  TableCellMenu,
  TableHeader,
  TableHeaderCell,
  TableRow,
} from "~/components/primitives/Table";
import { SimpleTooltip } from "~/components/primitives/Tooltip";
import { LiveTimer } from "~/components/runs/v3/LiveTimer";
import { RunTag } from "~/components/runs/v3/RunTag";
import { useEnvironment } from "~/hooks/useEnvironment";
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
import {
  type SessionListItem,
  type SessionList,
} from "~/presenters/v3/SessionListPresenter.server";
import { v3RunPath, v3RunsPath, v3SessionPath } from "~/utils/pathBuilder";
import {
  descriptionForSessionStatus,
  SessionStatusCombo,
  allSessionStatuses,
} from "./SessionStatus";

type SessionsTableProps = Pick<SessionList, "sessions" | "filters" | "hasFilters">;

export function SessionsTable({ sessions, hasFilters }: SessionsTableProps) {
  const navigation = useNavigation();
  const location = useLocation();
  const isLoading =
    navigation.state !== "idle" && navigation.location?.pathname === location.pathname;

  const organization = useOrganization();
  const project = useProject();
  const environment = useEnvironment();

  return (
    <Table className="max-h-full overflow-y-auto">
      <TableHeader>
        <TableRow>
          <TableHeaderCell>ID</TableHeaderCell>
          <TableHeaderCell
            tooltip={
              <div className="flex flex-col divide-y divide-grid-dimmed">
                {allSessionStatuses.map((status) => (
                  <div
                    key={status}
                    className="grid grid-cols-[6rem_1fr] gap-x-2 py-2 first:pt-1 last:pb-1"
                  >
                    <div className="mb-0.5 flex items-center gap-1.5 whitespace-nowrap">
                      <SessionStatusCombo status={status} iconClassName="animate-none" />
                    </div>
                    <Paragraph variant="extra-small" className="!text-wrap text-text-dimmed">
                      {descriptionForSessionStatus(status)}
                    </Paragraph>
                  </div>
                ))}
              </div>
            }
          >
            Status
          </TableHeaderCell>
          <TableHeaderCell>Type</TableHeaderCell>
          <TableHeaderCell>Task</TableHeaderCell>
          <TableHeaderCell>Tags</TableHeaderCell>
          <TableHeaderCell>Created</TableHeaderCell>
          <TableHeaderCell>Duration</TableHeaderCell>
          <TableHeaderCell>
            <span className="sr-only">Actions</span>
          </TableHeaderCell>
        </TableRow>
      </TableHeader>
      <TableBody>
        {sessions.length === 0 ? (
          <TableBlankRow colSpan={8}>
            <div className="flex items-center justify-center">
              <Paragraph className="w-auto">
                {hasFilters
                  ? "No sessions match these filters"
                  : "No sessions in this environment yet"}
              </Paragraph>
            </div>
          </TableBlankRow>
        ) : (
          sessions.map((session) => {
            const runPath = session.currentRunFriendlyId
              ? v3RunPath(organization, project, environment, {
                  friendlyId: session.currentRunFriendlyId,
                })
              : undefined;

            const displayId = session.externalId ?? session.friendlyId;
            const sessionPath = v3SessionPath(organization, project, environment, {
              friendlyId: session.friendlyId,
            });
            const allRunsPath = v3RunsPath(organization, project, environment, {
              tags: [`chat:${displayId}`],
            });

            return (
              <TableRow key={session.id}>
                <TableCell to={sessionPath} isTabbableCell>
                  <div className="w-[28ch]">
                    <MiddleTruncate text={displayId} className="font-mono text-xs" />
                  </div>
                </TableCell>
                <TableCell to={sessionPath}>
                  <SimpleTooltip
                    content={descriptionForSessionStatus(session.status)}
                    disableHoverableContent
                    button={<SessionStatusCombo status={session.status} />}
                  />
                </TableCell>
                <TableCell to={sessionPath}>
                  <span className="font-mono text-xs">{session.type}</span>
                </TableCell>
                <TableCell to={sessionPath}>
                  <div className="w-[24ch]">
                    <MiddleTruncate
                      text={session.taskIdentifier}
                      className="font-mono text-xs"
                    />
                  </div>
                </TableCell>
                <TableCell to={sessionPath}>
                  {session.tags.length > 0 ? (
                    <div className="flex flex-wrap gap-1">
                      {session.tags.map((tag) => (
                        <RunTag key={tag} tag={tag} />
                      ))}
                    </div>
                  ) : (
                    <span className="text-text-dimmed">–</span>
                  )}
                </TableCell>
                <TableCell to={sessionPath}>
                  <DateTime date={session.createdAt} />
                </TableCell>
                <TableCell
                  to={sessionPath}
                  className="w-[1%]"
                  actionClassName="pr-0 tabular-nums"
                >
                  <SessionDuration session={session} />
                </TableCell>
                <SessionActionsCell runPath={runPath} allRunsPath={allRunsPath} />
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

function SessionDuration({ session }: { session: SessionListItem }) {
  // Active sessions tick live; closed/expired sessions freeze at the
  // moment they ended (closedAt for explicit closes, expiresAt when the
  // TTL ran out without a close call).
  const endedAt =
    session.status === "CLOSED"
      ? session.closedAt
      : session.status === "EXPIRED"
        ? session.expiresAt
        : undefined;

  if (endedAt) {
    return <>{formatDuration(new Date(session.createdAt), new Date(endedAt), { style: "short" })}</>;
  }

  return <LiveTimer startTime={new Date(session.createdAt)} />;
}

function SessionActionsCell({
  runPath,
  allRunsPath,
}: {
  runPath?: string;
  allRunsPath: string;
}) {
  return (
    <TableCellMenu
      isSticky
      popoverContent={
        <>
          {runPath && (
            <PopoverMenuItem
              to={runPath}
              icon={ArrowRightIcon}
              leadingIconClassName="text-runs"
              title="View current run"
            />
          )}
          <PopoverMenuItem
            to={allRunsPath}
            icon={ListBulletIcon}
            leadingIconClassName="text-runs"
            title="View all runs"
          />
        </>
      }
    />
  );
}
