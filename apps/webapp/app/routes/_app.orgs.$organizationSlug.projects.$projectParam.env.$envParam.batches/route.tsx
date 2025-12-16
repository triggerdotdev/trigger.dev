import { ArrowRightIcon, ExclamationCircleIcon } from "@heroicons/react/20/solid";
import { BookOpenIcon } from "@heroicons/react/24/solid";
import { type MetaFunction, Outlet, useNavigation, useParams, useLocation } from "@remix-run/react";
import { type LoaderFunctionArgs } from "@remix-run/server-runtime";
import { formatDuration } from "@trigger.dev/core/v3/utils/durations";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { BatchesNone } from "~/components/BlankStatePanels";
import { ListPagination } from "~/components/ListPagination";
import { AdminDebugTooltip } from "~/components/admin/debugTooltip";
import { MainCenteredContainer, PageBody, PageContainer } from "~/components/layout/AppLayout";
import { LinkButton } from "~/components/primitives/Buttons";
import { DateTime } from "~/components/primitives/DateTime";
import { NavBar, PageAccessories, PageTitle } from "~/components/primitives/PageHeader";
import { Paragraph } from "~/components/primitives/Paragraph";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "~/components/primitives/Resizable";
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
import { BatchFilters, BatchListFilters } from "~/components/runs/v3/BatchFilters";
import {
  allBatchStatuses,
  BatchStatusCombo,
  descriptionForBatchStatus,
} from "~/components/runs/v3/BatchStatus";
import { LiveTimer } from "~/components/runs/v3/LiveTimer";
import { useEnvironment } from "~/hooks/useEnvironment";
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
import { redirectWithErrorMessage } from "~/models/message.server";
import { findProjectBySlug } from "~/models/project.server";
import { findEnvironmentBySlug } from "~/models/runtimeEnvironment.server";
import { type BatchList, BatchListPresenter } from "~/presenters/v3/BatchListPresenter.server";
import { requireUserId } from "~/services/session.server";
import {
  docsPath,
  EnvironmentParamSchema,
  v3BatchPath,
  v3BatchRunsPath,
} from "~/utils/pathBuilder";

export const meta: MetaFunction = () => {
  return [
    {
      title: `Batches | Trigger.dev`,
    },
  ];
};

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const userId = await requireUserId(request);
  const { projectParam, organizationSlug, envParam } = EnvironmentParamSchema.parse(params);

  const project = await findProjectBySlug(organizationSlug, projectParam, userId);
  if (!project) {
    return redirectWithErrorMessage("/", request, "Project not found");
  }

  const environment = await findEnvironmentBySlug(project.id, envParam, userId);
  if (!environment) {
    throw new Error("Environment not found");
  }

  const url = new URL(request.url);
  const s = {
    cursor: url.searchParams.get("cursor") ?? undefined,
    direction: url.searchParams.get("direction") ?? undefined,
    statuses: url.searchParams.getAll("statuses"),
    period: url.searchParams.get("period") ?? undefined,
    from: url.searchParams.get("from") ?? undefined,
    to: url.searchParams.get("to") ?? undefined,
    id: url.searchParams.get("id") ?? undefined,
  };
  const filters = BatchListFilters.parse(s);

  const presenter = new BatchListPresenter();
  const list = await presenter.call({
    userId,
    projectId: project.id,
    ...filters,
    friendlyId: filters.id,
    environmentId: environment.id,
  });

  return typedjson(list);
};

export default function Page() {
  const { batches, hasFilters, hasAnyBatches, filters, pagination } =
    useTypedLoaderData<typeof loader>();
  const { batchParam } = useParams();
  const isShowingInspector = batchParam !== undefined;

  return (
    <PageContainer>
      <NavBar>
        <PageTitle title="Batches" />
        <PageAccessories>
          <AdminDebugTooltip />
          <LinkButton
            variant={"docs/small"}
            LeadingIcon={BookOpenIcon}
            to={docsPath("/triggering")}
          >
            Batches docs
          </LinkButton>
        </PageAccessories>
      </NavBar>
      <PageBody scrollable={false}>
        {!hasAnyBatches ? (
          <MainCenteredContainer className="max-w-md">
            <BatchesNone />
          </MainCenteredContainer>
        ) : (
          <ResizablePanelGroup orientation="horizontal" className="max-h-full">
            <ResizablePanel id="batches-main" min={"100px"}>
              <div className="grid h-full max-h-full grid-rows-[auto_1fr] overflow-hidden">
                <div className="flex items-start justify-between gap-x-2 p-2">
                  <BatchFilters hasFilters={hasFilters} />
                  <div className="flex items-center justify-end gap-x-2">
                    <ListPagination list={{ pagination }} />
                  </div>
                </div>

                <BatchesTable
                  batches={batches}
                  filters={filters}
                  hasFilters={hasFilters}
                  pagination={pagination}
                  hasAnyBatches={hasAnyBatches}
                />
              </div>
            </ResizablePanel>
            {isShowingInspector && (
              <>
                <ResizableHandle id="batches-handle" />
                <ResizablePanel id="batches-inspector" min="100px" default="500px">
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

function BatchesTable({ batches, hasFilters, filters }: BatchList) {
  const navigation = useNavigation();
  const location = useLocation();
  const isLoading =
    navigation.state !== "idle" && navigation.location?.pathname === location.pathname;

  const organization = useOrganization();
  const project = useProject();
  const environment = useEnvironment();
  const { batchParam } = useParams();

  return (
    <Table className="max-h-full overflow-y-auto">
      <TableHeader>
        <TableRow>
          <TableHeaderCell>ID</TableHeaderCell>
          <TableHeaderCell
            tooltip={
              <div className="flex flex-col divide-y divide-grid-dimmed">
                {allBatchStatuses.map((status) => (
                  <div
                    key={status}
                    className="grid grid-cols-[8rem_1fr] gap-x-2 py-2 first:pt-1 last:pb-1"
                  >
                    <div className="mb-0.5 flex items-center gap-1.5 whitespace-nowrap">
                      <BatchStatusCombo status={status} />
                    </div>
                    <Paragraph variant="extra-small" className="!text-wrap text-text-dimmed">
                      {descriptionForBatchStatus(status)}
                    </Paragraph>
                  </div>
                ))}
              </div>
            }
          >
            Status
          </TableHeaderCell>
          <TableHeaderCell>Runs</TableHeaderCell>
          <TableHeaderCell>Duration</TableHeaderCell>
          <TableHeaderCell>Created</TableHeaderCell>
          <TableHeaderCell>Finished</TableHeaderCell>
          <TableHeaderCell>
            <span className="sr-only">Go to batch</span>
          </TableHeaderCell>
        </TableRow>
      </TableHeader>
      <TableBody>
        {batches.length === 0 ? (
          <TableBlankRow colSpan={8}>
            <div className="flex items-center justify-center">
              <Paragraph className="w-auto">No batches match these filters</Paragraph>
            </div>
          </TableBlankRow>
        ) : (
          batches.map((batch) => {
            const basePath = v3BatchPath(organization, project, environment, batch);
            const inspectorPath = `${basePath}${location.search}`;
            const runsPath = v3BatchRunsPath(organization, project, environment, batch);
            const isSelected = batchParam === batch.friendlyId;

            return (
              <TableRow key={batch.id} className={isSelected ? "bg-grid-dimmed" : undefined}>
                <TableCell to={inspectorPath} isTabbableCell>
                  {batch.friendlyId}
                </TableCell>

                <TableCell to={inspectorPath}>
                  {batch.batchVersion === "v1" ? (
                    <SimpleTooltip
                      content="Upgrade to the latest SDK for batch statuses to appear."
                      disableHoverableContent
                      button={
                        <span className="flex items-center gap-1">
                          <ExclamationCircleIcon className="size-4 text-text-dimmed" />
                          <span>Legacy batch</span>
                        </span>
                      }
                    />
                  ) : (
                    <SimpleTooltip
                      content={descriptionForBatchStatus(batch.status)}
                      disableHoverableContent
                      button={<BatchStatusCombo status={batch.status} />}
                    />
                  )}
                </TableCell>
                <TableCell to={inspectorPath}>{batch.runCount}</TableCell>
                <TableCell
                  to={inspectorPath}
                  className="w-[1%]"
                  actionClassName="pr-0 tabular-nums"
                >
                  {batch.finishedAt ? (
                    formatDuration(new Date(batch.createdAt), new Date(batch.finishedAt), {
                      style: "short",
                    })
                  ) : (
                    <LiveTimer startTime={new Date(batch.createdAt)} />
                  )}
                </TableCell>
                <TableCell to={inspectorPath}>
                  <DateTime date={batch.createdAt} />
                </TableCell>
                <TableCell to={inspectorPath}>
                  {batch.finishedAt ? <DateTime date={batch.finishedAt} /> : "–"}
                </TableCell>
                <BatchActionsCell runsPath={runsPath} />
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

function BatchActionsCell({ runsPath }: { runsPath: string }) {
  return (
    <TableCellMenu
      isSticky
      hiddenButtons={
        <LinkButton to={runsPath} variant="minimal/small" LeadingIcon={ArrowRightIcon}>
          View runs
        </LinkButton>
      }
    />
  );
}
