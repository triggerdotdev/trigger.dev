import {
  ArrowPathRoundedSquareIcon,
  ArrowRightIcon,
  ExclamationCircleIcon,
} from "@heroicons/react/20/solid";
import { BookOpenIcon } from "@heroicons/react/24/solid";
import { type MetaFunction, useLocation, useNavigation } from "@remix-run/react";
import { type LoaderFunctionArgs } from "@remix-run/server-runtime";
import { formatDuration } from "@trigger.dev/core/v3/utils/durations";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { BatchesNone } from "~/components/BlankStatePanels";
import { ListPagination } from "~/components/ListPagination";
import { AdminDebugTooltip } from "~/components/admin/debugTooltip";
import { MainCenteredContainer, PageBody, PageContainer } from "~/components/layout/AppLayout";
import { Button, LinkButton } from "~/components/primitives/Buttons";
import { DateTime } from "~/components/primitives/DateTime";
import { Dialog, DialogTrigger } from "~/components/primitives/Dialog";
import { NavBar, PageAccessories, PageTitle } from "~/components/primitives/PageHeader";
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
import { BatchFilters, BatchListFilters } from "~/components/runs/v3/BatchFilters";
import {
  allBatchStatuses,
  BatchStatusCombo,
  descriptionForBatchStatus,
} from "~/components/runs/v3/BatchStatus";
import { CheckBatchCompletionDialog } from "~/components/runs/v3/CheckBatchCompletionDialog";
import { LiveTimer } from "~/components/runs/v3/LiveTimer";
import { useEnvironment } from "~/hooks/useEnvironment";
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
import { redirectWithErrorMessage } from "~/models/message.server";
import { findProjectBySlug } from "~/models/project.server";
import { findEnvironmentBySlug } from "~/models/runtimeEnvironment.server";
import {
  type BatchList,
  type BatchListItem,
  BatchListPresenter,
} from "~/presenters/v3/BatchListPresenter.server";
import { requireUserId } from "~/services/session.server";
import { docsPath, EnvironmentParamSchema, v3BatchRunsPath } from "~/utils/pathBuilder";

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
        )}
      </PageBody>
    </PageContainer>
  );
}

function BatchesTable({ batches, hasFilters, filters }: BatchList) {
  const navigation = useNavigation();
  const isLoading = navigation.state !== "idle";
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
          batches.map((batch, index) => {
            const path = v3BatchRunsPath(organization, project, environment, batch);
            return (
              <TableRow key={batch.id}>
                <TableCell to={path} isTabbableCell>
                  {batch.friendlyId}
                </TableCell>

                <TableCell to={path}>
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
                <TableCell to={path}>{batch.runCount}</TableCell>
                <TableCell to={path} className="w-[1%]" actionClassName="pr-0 tabular-nums">
                  {batch.finishedAt ? (
                    formatDuration(new Date(batch.createdAt), new Date(batch.finishedAt), {
                      style: "short",
                    })
                  ) : (
                    <LiveTimer startTime={new Date(batch.createdAt)} />
                  )}
                </TableCell>
                <TableCell to={path}>
                  <DateTime date={batch.createdAt} />
                </TableCell>
                <TableCell to={path}>
                  {batch.finishedAt ? <DateTime date={batch.finishedAt} /> : "–"}
                </TableCell>
                <BatchActionsCell batch={batch} path={path} />
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

function BatchActionsCell({ batch, path }: { batch: BatchListItem; path: string }) {
  const location = useLocation();

  if (batch.hasFinished || batch.environment.type === "DEVELOPMENT") {
    return <TableCell to={path}>{""}</TableCell>;
  }

  return (
    <TableCellMenu
      isSticky
      popoverContent={
        <>
          <PopoverMenuItem
            to={path}
            icon={ArrowRightIcon}
            leadingIconClassName="text-blue-500"
            title="View batch"
          />
          {!batch.hasFinished && (
            <Dialog>
              <DialogTrigger
                asChild
                className="size-6 rounded-sm p-1 text-text-dimmed transition hover:bg-charcoal-700 hover:text-text-bright"
              >
                <Button
                  variant="small-menu-item"
                  LeadingIcon={ArrowPathRoundedSquareIcon}
                  leadingIconClassName="text-success"
                  fullWidth
                  textAlignLeft
                  className="w-full px-1.5 py-[0.9rem]"
                >
                  Try and resume
                </Button>
              </DialogTrigger>
              <CheckBatchCompletionDialog
                batchId={batch.id}
                redirectPath={`${location.pathname}${location.search}`}
              />
            </Dialog>
          )}
        </>
      }
    />
  );
}
