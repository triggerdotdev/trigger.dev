import { PlusIcon } from "@heroicons/react/20/solid";
import { NoSymbolIcon } from "@heroicons/react/24/solid";
import { type LoaderFunctionArgs } from "@remix-run/server-runtime";
import { tryCatch } from "@trigger.dev/core";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { z } from "zod";
import { DocsHeaderButton } from "~/components/DocsPanel";
import { AdminDebugTooltip } from "~/components/admin/debugTooltip";
import { BulkActionsNone } from "~/components/BlankStatePanels";
import { MainCenteredContainer, PageBody, PageContainer } from "~/components/layout/AppLayout";
import { Button, LinkButton } from "~/components/primitives/Buttons";
import { DateTime } from "~/components/primitives/DateTime";
import { Dialog, DialogTrigger } from "~/components/primitives/Dialog";
import { NavBar, PageAccessories, PageTitle } from "~/components/primitives/PageHeader";
import { PaginationControls } from "~/components/primitives/Pagination";
import { Paragraph } from "~/components/primitives/Paragraph";
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
import { TruncatedCopyableValue } from "~/components/primitives/TruncatedCopyableValue";
import { AbortBulkActionDialog } from "~/components/runs/v3/AbortBulkActionDialog";
import { BulkActionStatusCombo, BulkActionTypeCombo } from "~/components/runs/v3/BulkAction";
import { BulkActionFilters, BulkActionListFilters } from "~/components/runs/v3/BulkActionFilters";
import { UserAvatar } from "~/components/UserProfilePhoto";
import { useEnvironment } from "~/hooks/useEnvironment";
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
import { findProjectBySlug } from "~/models/project.server";
import { findEnvironmentBySlug } from "~/models/runtimeEnvironment.server";
import {
  type BulkActionListItem,
  BulkActionListPresenter,
} from "~/presenters/v3/BulkActionListPresenter.server";
import { rbac } from "~/services/rbac.server";
import { checkPermissions } from "~/services/routeBuilders/permissions.server";
import { requireUserId } from "~/services/session.server";
import { cn } from "~/utils/cn";
import {
  EnvironmentParamSchema,
  v3BulkActionPath,
  v3CreateBulkActionPath,
} from "~/utils/pathBuilder";
import { bulkActionsAgentPageContext } from "~/components/dashboard-agent/suggested-prompts";
import { WhenAgentUnavailable } from "~/components/dashboard-agent/WhenAgentUnavailable";
import type { Handle } from "~/utils/handle";

export const handle: Handle = {
  agentPageContext: (data) => bulkActionsAgentPageContext(data),
};
import { pageMeta } from "~/utils/pageTitle";

export const meta = pageMeta("Bulk actions");

const SearchParamsSchema = BulkActionListFilters.extend({
  page: z.coerce.number().optional(),
});

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const userId = await requireUserId(request);

  const { organizationSlug, projectParam, envParam } = EnvironmentParamSchema.parse(params);

  const project = await findProjectBySlug(organizationSlug, projectParam, userId);
  if (!project) {
    throw new Response("Not Found", { status: 404 });
  }

  const environment = await findEnvironmentBySlug(project.id, envParam, userId);
  if (!environment) {
    throw new Response("Not Found", { status: 404 });
  }

  try {
    const url = new URL(request.url);
    const { page, types, statuses, users } = SearchParamsSchema.parse({
      page: url.searchParams.get("page") ?? undefined,
      types: url.searchParams.getAll("types"),
      statuses: url.searchParams.getAll("statuses"),
      users: url.searchParams.getAll("users"),
    });

    const presenter = new BulkActionListPresenter();
    const [error, data] = await tryCatch(
      presenter.call({
        environmentId: environment.id,
        page,
        types,
        statuses,
        users,
      })
    );

    if (error) {
      throw new Error(error.message);
    }

    // Display flag for the row-menu Abort control. The abort action route
    // enforces write:runs independently. Permissive in OSS.
    const bulkAuth = await rbac.authenticateSession(request, {
      userId,
      organizationId: project.organizationId,
    });
    const { canAbort } = bulkAuth.ok
      ? checkPermissions(bulkAuth.ability, {
          canAbort: { action: "write", resource: { type: "runs" } },
        })
      : { canAbort: true };

    return typedjson({ ...data, canAbort });
  } catch (error) {
    console.error(error);
    throw new Response(undefined, {
      status: 400,
      statusText: "Something went wrong, if this problem persists please contact support.",
    });
  }
};

export default function Page() {
  const {
    bulkActions,
    currentPage,
    totalPages,
    totalCount: _totalCount,
    canAbort,
    users,
    hasFilters,
  } = useTypedLoaderData<typeof loader>();
  const organization = useOrganization();
  const project = useProject();
  const environment = useEnvironment();

  return (
    <PageContainer>
      <NavBar>
        <PageTitle title="Bulk actions" />
        <PageAccessories>
          <AdminDebugTooltip />
          <WhenAgentUnavailable>
            <DocsHeaderButton path="/bulk-actions">Bulk actions docs</DocsHeaderButton>
          </WhenAgentUnavailable>
          <LinkButton
            variant="primary/small"
            LeadingIcon={PlusIcon}
            to={v3CreateBulkActionPath(organization, project, environment)}
            shortcut={{
              key: "n",
            }}
          >
            New bulk action
          </LinkButton>
        </PageAccessories>
      </NavBar>
      <PageBody scrollable={false}>
        {bulkActions.length === 0 && !hasFilters ? (
          <MainCenteredContainer className="max-w-prose">
            <BulkActionsNone />
          </MainCenteredContainer>
        ) : (
          <div
            className={cn(
              "grid max-h-full min-h-full overflow-x-auto",
              totalPages > 1 ? "grid-rows-[auto_1fr_auto]" : "grid-rows-[auto_1fr]"
            )}
          >
            <div className="flex items-center justify-between gap-x-2 p-2">
              <BulkActionFilters users={users} />
              <PaginationControls
                currentPage={currentPage}
                totalPages={totalPages}
                showPageNumbers={false}
              />
            </div>

            <BulkActionsTable
              bulkActions={bulkActions}
              totalPages={totalPages}
              canAbort={canAbort}
            />
            {totalPages > 1 && (
              <div className="flex min-h-full justify-end border-t border-grid-dimmed px-2 py-3">
                <PaginationControls currentPage={currentPage} totalPages={totalPages} />
              </div>
            )}
          </div>
        )}
      </PageBody>
    </PageContainer>
  );
}

function BulkActionsTable({
  bulkActions,
  totalPages,
  canAbort,
}: {
  bulkActions: BulkActionListItem[];
  totalPages: number;
  canAbort: boolean;
}) {
  const organization = useOrganization();
  const project = useProject();
  const environment = useEnvironment();
  return (
    <Table containerClassName={cn(totalPages === 1 && "border-t-0")}>
      <TableHeader>
        <TableRow>
          <TableHeaderCell>ID</TableHeaderCell>
          <TableHeaderCell>Name</TableHeaderCell>
          <TableHeaderCell
            tooltip={
              <div className="flex flex-col divide-y divide-grid-dimmed">
                <div className="grid grid-cols-[8rem_1fr] gap-x-2 py-2 first:pt-1 last:pb-1">
                  <div className="mb-0.5 flex items-center gap-1.5 whitespace-nowrap">
                    <BulkActionStatusCombo status="PENDING" />
                  </div>
                  <Paragraph variant="extra-small" className="text-wrap! text-text-dimmed">
                    The bulk action is currently in progress. They can take some time if there are
                    lots of runs.
                  </Paragraph>
                </div>
                <div className="grid grid-cols-[8rem_1fr] gap-x-2 py-2 first:pt-1 last:pb-1">
                  <div className="mb-0.5 flex items-center gap-1.5 whitespace-nowrap">
                    <BulkActionStatusCombo status="COMPLETED" />
                  </div>
                  <Paragraph variant="extra-small" className="text-wrap! text-text-dimmed">
                    The bulk action has completed successfully.
                  </Paragraph>
                </div>
                <div className="grid grid-cols-[8rem_1fr] gap-x-2 py-2 first:pt-1 last:pb-1">
                  <div className="mb-0.5 flex items-center gap-1.5 whitespace-nowrap">
                    <BulkActionStatusCombo status="ABORTED" />
                  </div>
                  <Paragraph variant="extra-small" className="text-wrap! text-text-dimmed">
                    The bulk action was aborted.
                  </Paragraph>
                </div>
              </div>
            }
          >
            Status
          </TableHeaderCell>
          <TableHeaderCell>Bulk action</TableHeaderCell>
          <TableHeaderCell>Runs</TableHeaderCell>
          <TableHeaderCell>User</TableHeaderCell>
          <TableHeaderCell>Created</TableHeaderCell>
          <TableHeaderCell>Completed</TableHeaderCell>
          <TableHeaderCell>
            <span className="sr-only">Actions</span>
          </TableHeaderCell>
        </TableRow>
      </TableHeader>
      <TableBody>
        {bulkActions.length === 0 ? (
          <TableBlankRow colSpan={9}>There are no matching bulk actions</TableBlankRow>
        ) : (
          bulkActions.map((bulkAction) => {
            const path = v3BulkActionPath(organization, project, environment, bulkAction);
            return (
              <TableRow key={bulkAction.friendlyId}>
                <TableCell to={path} isTabbableCell>
                  <TruncatedCopyableValue value={bulkAction.friendlyId} />
                </TableCell>
                <TableCell to={path}>{bulkAction.name || "–"}</TableCell>
                <TableCell to={path}>
                  <BulkActionStatusCombo status={bulkAction.status} />
                </TableCell>
                <TableCell to={path}>
                  <BulkActionTypeCombo type={bulkAction.type} />
                </TableCell>
                <TableCell to={path}>{bulkAction.totalCount}</TableCell>
                <TableCell to={path}>
                  {bulkAction.user ? (
                    <div className="flex items-center gap-1">
                      <UserAvatar
                        name={bulkAction.user.name}
                        avatarUrl={bulkAction.user.avatarUrl}
                        className="h-4 w-4"
                      />
                      <Paragraph variant="extra-small">{bulkAction.user.name}</Paragraph>
                    </div>
                  ) : (
                    "–"
                  )}
                </TableCell>
                <TableCell to={path}>
                  <DateTime date={bulkAction.createdAt} />
                </TableCell>
                <TableCell to={path}>
                  {bulkAction.completedAt ? <DateTime date={bulkAction.completedAt} /> : "–"}
                </TableCell>
                <BulkActionActionsCell bulkAction={bulkAction} path={path} canAbort={canAbort} />
              </TableRow>
            );
          })
        )}
      </TableBody>
    </Table>
  );
}

function BulkActionActionsCell({
  bulkAction,
  path,
  canAbort,
}: {
  bulkAction: BulkActionListItem;
  path: string;
  canAbort: boolean;
}) {
  // Abort is the only action, and only while the bulk action is still running.
  if (bulkAction.status !== "PENDING") {
    return <TableCell to={path}>{""}</TableCell>;
  }

  return (
    <TableCellMenu
      isSticky
      hiddenButtons={
        canAbort ? (
          <Dialog>
            <DialogTrigger asChild>
              <Button
                variant="minimal/small"
                LeadingIcon={NoSymbolIcon}
                leadingIconClassName="text-error"
              >
                <span className="text-text-bright">Abort…</span>
              </Button>
            </DialogTrigger>
            <AbortBulkActionDialog formAction={path} />
          </Dialog>
        ) : (
          <Button
            variant="minimal/small"
            LeadingIcon={NoSymbolIcon}
            leadingIconClassName="text-error"
            disabled
            tooltip="You don't have permission to abort bulk actions"
          >
            <span className="text-text-bright">Abort…</span>
          </Button>
        )
      }
    />
  );
}
