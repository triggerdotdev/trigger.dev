import { BookOpenIcon, PlusIcon } from "@heroicons/react/20/solid";
import { Outlet, useParams, type MetaFunction } from "@remix-run/react";
import { type LoaderFunctionArgs } from "@remix-run/server-runtime";
import { tryCatch } from "@trigger.dev/core";
import { schedules } from "@trigger.dev/sdk";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { z } from "zod";
import { AdminDebugTooltip } from "~/components/admin/debugTooltip";
import { BulkActionsNone } from "~/components/BlankStatePanels";
import { InlineCode } from "~/components/code/InlineCode";
import { EnvironmentCombo } from "~/components/environments/EnvironmentLabel";
import { MainCenteredContainer, PageBody, PageContainer } from "~/components/layout/AppLayout";
import { LinkButton } from "~/components/primitives/Buttons";
import { TruncatedCopyableValue } from "~/components/primitives/TruncatedCopyableValue";
import { DateTime } from "~/components/primitives/DateTime";
import { NavBar, PageAccessories, PageTitle } from "~/components/primitives/PageHeader";
import { PaginationControls } from "~/components/primitives/Pagination";
import { Paragraph } from "~/components/primitives/Paragraph";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "~/components/primitives/Resizable";
import {
  Table,
  TableBlankRow,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
} from "~/components/primitives/Table";
import { BulkActionStatusCombo, BulkActionTypeCombo } from "~/components/runs/v3/BulkAction";
import { EnabledStatus } from "~/components/runs/v3/EnabledStatus";
import {
  ScheduleTypeIcon,
  scheduleTypeName,
  ScheduleTypeCombo,
} from "~/components/runs/v3/ScheduleType";
import { UserAvatar } from "~/components/UserProfilePhoto";
import { useEnvironment } from "~/hooks/useEnvironment";
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
import { findProjectBySlug } from "~/models/project.server";
import { findEnvironmentBySlug } from "~/models/runtimeEnvironment.server";
import {
  BulkActionListItem,
  BulkActionListPresenter,
} from "~/presenters/v3/BulkActionListPresenter.server";
import { requireUserId } from "~/services/session.server";
import { cn } from "~/utils/cn";
import {
  docsPath,
  EnvironmentParamSchema,
  v3BulkActionPath,
  v3CreateBulkActionPath,
  v3SchedulePath,
} from "~/utils/pathBuilder";

export const meta: MetaFunction = () => {
  return [
    {
      title: `Bulk actions | Trigger.dev`,
    },
  ];
};

const SearchParamsSchema = z.object({
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
    const { page } = SearchParamsSchema.parse(Object.fromEntries(url.searchParams));

    const presenter = new BulkActionListPresenter();
    const [error, data] = await tryCatch(
      presenter.call({
        environmentId: environment.id,
        page,
      })
    );

    if (error) {
      throw new Error(error.message);
    }

    return typedjson(data);
  } catch (error) {
    console.error(error);
    throw new Response(undefined, {
      status: 400,
      statusText: "Something went wrong, if this problem persists please contact support.",
    });
  }
};

export default function Page() {
  const { bulkActions, currentPage, totalPages, totalCount } = useTypedLoaderData<typeof loader>();
  const organization = useOrganization();
  const project = useProject();
  const environment = useEnvironment();
  const { bulkActionParam } = useParams();
  const isShowingInspector = bulkActionParam !== undefined;

  return (
    <PageContainer>
      <NavBar>
        <PageTitle title="Bulk actions" />
        <PageAccessories>
          <AdminDebugTooltip />
          <LinkButton
            variant={"docs/small"}
            LeadingIcon={BookOpenIcon}
            to={docsPath("/bulk-actions")}
          >
            Bulk actions docs
          </LinkButton>
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
        {bulkActions.length === 0 ? (
          <MainCenteredContainer className="max-w-md">
            <BulkActionsNone />
          </MainCenteredContainer>
        ) : (
          <ResizablePanelGroup orientation="horizontal" className="max-h-full">
            <ResizablePanel id="bulk-actions-main" min={"100px"}>
              <div
                className={cn(
                  "grid max-h-full min-h-full overflow-x-auto",
                  totalPages > 1 ? "grid-rows-[auto_1fr_auto]" : "grid-rows-[auto_1fr]"
                )}
              >
                <div className="flex items-center justify-end gap-x-2 p-2">
                  <div className="flex items-center justify-end gap-x-2">
                    <PaginationControls
                      currentPage={currentPage}
                      totalPages={totalPages}
                      showPageNumbers={false}
                    />
                  </div>
                </div>

                <BulkActionsTable bulkActions={bulkActions} />
                {totalPages > 1 && (
                  <div
                    className={cn(
                      "flex min-h-full",
                      totalPages > 1 && "justify-end border-t border-grid-dimmed px-2 py-3"
                    )}
                  >
                    <PaginationControls currentPage={currentPage} totalPages={totalPages} />
                  </div>
                )}
              </div>
            </ResizablePanel>
            {isShowingInspector && (
              <>
                <ResizableHandle id="bulk-actions-handle" />
                <ResizablePanel id="bulk-actions-inspector" min="100px" default="500px">
                  <Outlet />
                </ResizablePanel>
              </>
            )}
          </ResizablePanelGroup>
        )}
      </PageBody>
    </PageContainer>
  );
}

function BulkActionsTable({ bulkActions }: { bulkActions: BulkActionListItem[] }) {
  const organization = useOrganization();
  const project = useProject();
  const environment = useEnvironment();
  const { bulkActionParam } = useParams();

  return (
    <Table>
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
                  <Paragraph variant="extra-small" className="!text-wrap text-text-dimmed">
                    The bulk action is currently in progress. They can take some time if there are
                    lots of runs.
                  </Paragraph>
                </div>
                <div className="grid grid-cols-[8rem_1fr] gap-x-2 py-2 first:pt-1 last:pb-1">
                  <div className="mb-0.5 flex items-center gap-1.5 whitespace-nowrap">
                    <BulkActionStatusCombo status="COMPLETED" />
                  </div>
                  <Paragraph variant="extra-small" className="!text-wrap text-text-dimmed">
                    The bulk action has completed successfully.
                  </Paragraph>
                </div>
                <div className="grid grid-cols-[8rem_1fr] gap-x-2 py-2 first:pt-1 last:pb-1">
                  <div className="mb-0.5 flex items-center gap-1.5 whitespace-nowrap">
                    <BulkActionStatusCombo status="ABORTED" />
                  </div>
                  <Paragraph variant="extra-small" className="!text-wrap text-text-dimmed">
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
        </TableRow>
      </TableHeader>
      <TableBody>
        {bulkActions.length === 0 ? (
          <TableBlankRow colSpan={8}>There are no matching bulk actions</TableBlankRow>
        ) : (
          bulkActions.map((bulkAction) => {
            const path = v3BulkActionPath(organization, project, environment, bulkAction);
            const isSelected = bulkActionParam === bulkAction.friendlyId;

            return (
              <TableRow
                key={bulkAction.friendlyId}
                className={isSelected ? "bg-grid-dimmed" : undefined}
              >
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
              </TableRow>
            );
          })
        )}
      </TableBody>
    </Table>
  );
}
