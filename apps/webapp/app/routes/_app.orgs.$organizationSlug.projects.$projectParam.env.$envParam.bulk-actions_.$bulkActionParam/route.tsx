import { throwNotFound } from "~/utils/httpErrors";
import { ArrowPathIcon } from "@heroicons/react/20/solid";
import { NoSymbolIcon } from "@heroicons/react/24/solid";
import { tryCatch } from "@trigger.dev/core";
import { formatDurationMilliseconds } from "@trigger.dev/core/v3";
import simplur from "simplur";
import { useEffect, useState } from "react";
import { useLocation, useRevalidator } from "@remix-run/react";
import {
  typeddefer,
  type UseDataFunctionReturn,
  useTypedFetcher,
  useTypedLoaderData,
} from "remix-typedjson";
import {
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableBlankRow,
  TableHeaderCell,
  TableRow,
} from "~/components/primitives/Table";
import { z } from "zod";
import { RunsIcon } from "~/assets/icons/RunsIcon";
import { BulkActionFilterList } from "~/components/runs/v3/BulkActionFilterList";
import { DateTime, RelativeDateTime } from "~/components/primitives/DateTime";
import {
  DetailHeader,
  DetailPageTitle,
  DetailPage,
  DetailProperty,
  DetailTabs,
  PropertyGroup,
  PropertyPair,
  PropertyRail,
  useDetailTab,
} from "~/components/primitives/detail/DetailPage";
import { DeferredContent } from "~/components/primitives/detail/DeferredContent";
import {
  DetailTabError,
  DetailTableTab,
  DetailTabLoading,
  ProgressMeter,
} from "~/components/primitives/detail/DetailSections";
import { NavBar } from "~/components/primitives/PageHeader";
import { ListCheckedIcon } from "~/assets/icons/ListCheckedIcon";
import { VersionLabel } from "~/components/versions/VersionLabel";
import { Button, LinkButton } from "~/components/primitives/Buttons";
import { CopyableText } from "~/components/primitives/CopyableText";
import { Dialog, DialogTrigger } from "~/components/primitives/Dialog";
import { PaginationControls } from "~/components/primitives/Pagination";
import { Paragraph } from "~/components/primitives/Paragraph";
import { EnvironmentCombo } from "~/components/environments/EnvironmentLabel";
import { AbortBulkActionDialog } from "~/components/runs/v3/AbortBulkActionDialog";
import { BulkActionStatusCombo, BulkActionTypeCombo } from "~/components/runs/v3/BulkAction";
import { UserAvatar } from "~/components/UserProfilePhoto";
import { env } from "~/env.server";
import { $replica } from "~/db.server";
import { DirectionSchema, ListPagination } from "~/components/ListPagination";
import { PageBody, PageContainer } from "~/components/layout/AppLayout";
import { TaskRunsTable } from "~/components/runs/v3/TaskRunsTable";
import { NextRunListPresenter } from "~/presenters/v3/NextRunListPresenter.server";
import { runIdCreatedAtBounds } from "~/services/runsRepository/runsRepository.server";
import type { loader as progressLoader } from "~/routes/resources.orgs.$organizationSlug.projects.$projectParam.env.$envParam.bulk-actions.$bulkActionParam.progress";
import { getRunColumnsForSelect } from "~/presenters/v3/runColumnsFromRequest.server";
import { clickhouseFactory } from "~/services/clickhouse/clickhouseFactoryInstance.server";
import { useInterval } from "~/hooks/useInterval";
import { useEnvironment } from "~/hooks/useEnvironment";
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
import { redirectWithErrorMessage, redirectWithSuccessMessage } from "~/models/message.server";
import { resolveProjectAuthScope } from "~/services/projectAuthScope.server";
import { findProjectBySlug } from "~/models/project.server";
import { findEnvironmentBySlug, hasAccessToEnvironment } from "~/models/runtimeEnvironment.server";
import { BulkActionPresenter } from "~/presenters/v3/BulkActionPresenter.server";
import { logger } from "~/services/logger.server";
import { dashboardAction, dashboardLoader } from "~/services/routeBuilders/dashboardBuilder";
import { checkPermissions } from "~/services/routeBuilders/permissions.server";
import { formatNumber } from "~/utils/numberFormatter";
import {
  EnvironmentParamSchema,
  v3BulkActionPath,
  v3BulkActionsPath,
  v3CreateBulkActionPath,
  v3RunPath,
  v3RunsPath,
} from "~/utils/pathBuilder";
import { BulkActionService } from "~/v3/services/bulk/BulkActionV2.server";
import { bulkActionsAgentPageContext } from "~/components/dashboard-agent/suggested-prompts";
import type { Handle } from "~/utils/handle";
import { pageMeta } from "~/utils/pageTitle";

export const meta = pageMeta<typeof loader>(({ data, params }) => [
  data?.bulkAction?.name || params.bulkActionParam || "Bulk action",
  "Bulk actions",
]);

/** Slack either side of a replay's own start and end when listing the runs it created. */
const RUNS_WINDOW_MARGIN_MS = 60_000;
const RUNS_WINDOW_FALLBACK_MS = 7 * 24 * 60 * 60 * 1000;

const BulkActionParamSchema = EnvironmentParamSchema.extend({
  bulkActionParam: z.string(),
});

export const loader = dashboardLoader(
  {
    params: BulkActionParamSchema,
    context: (params) => resolveProjectAuthScope(params.organizationSlug, params.projectParam),
    authorization: { action: "read", resource: { type: "runs" } },
  },
  async ({ params, user, ability, request }) => {
    const { organizationSlug, projectParam, envParam, bulkActionParam } = params;
    const url = new URL(request.url);
    const failedPage = Math.max(1, Number(url.searchParams.get("page")) || 1);

    const project = await findProjectBySlug(organizationSlug, projectParam, user.id);
    if (!project) {
      throw new Response("Not Found", { status: 404 });
    }

    const environment = await findEnvironmentBySlug(project.id, envParam, user.id);
    if (!environment) {
      throw new Response("Not Found", { status: 404 });
    }

    try {
      const presenter = new BulkActionPresenter();
      const [error, data] = await tryCatch(
        presenter.call({
          environmentId: environment.id,
          bulkActionId: bulkActionParam,
          userId: user.id,
          failedPage,
        })
      );

      if (error) {
        throw new Error(error.message);
      }

      if (!data) {
        throwNotFound("Bulk action not found");
      }

      const autoReloadPollIntervalMs = env.BULK_ACTION_AUTORELOAD_POLL_INTERVAL_MS;

      // bulkId selects the runs a cancel acted on, or the new runs a replay created. A replay
      // into another environment created them there, so the Runs tab lists that environment.
      const replayEnvironmentId = data.replayEnvironment?.id;
      const canSeeRuns =
        !replayEnvironmentId ||
        replayEnvironmentId === environment.id ||
        (await hasAccessToEnvironment({
          environmentId: replayEnvironmentId,
          projectId: project.id,
          organizationId: project.organizationId,
          userId: user.id,
        }));
      // The runs list filters on run creation time, and its 7-day default would hide older runs.
      // The runs a cancel acted on were created inside its frozen filter range or, for selected
      // runs, between the first and the last of them. A replay's new runs were created while it
      // ran. Both ends are passed so ClickHouse reads that window and nothing after it.
      const selectedRunIds =
        data.type !== "REPLAY" && !data.filters.from && !data.filters.to
          ? data.filters.runId
          : undefined;
      const selectedBounds = selectedRunIds?.length
        ? await runIdCreatedAtBounds(selectedRunIds, environment.id)
        : undefined;
      const endedAt = data.status === "PENDING" ? undefined : (data.completedAt ?? data.updatedAt);
      const runsFrom =
        data.type === "REPLAY"
          ? data.createdAt.getTime() - RUNS_WINDOW_MARGIN_MS
          : selectedRunIds?.length
            ? // Selected runs that are all gone leave nothing to list: any recent window does.
              (selectedBounds?.from ?? data.createdAt.getTime() - RUNS_WINDOW_FALLBACK_MS)
            : // A filter with no start (only "created before") covers everything before its end.
              (data.filters.from ?? 1);
      const runsTo =
        data.type === "REPLAY"
          ? endedAt && endedAt.getTime() + RUNS_WINDOW_MARGIN_MS
          : (data.filters.to ?? selectedBounds?.to);
      // Deferred: the header, rail and Failed tab render while ClickHouse answers.
      const onRunsTab = url.searchParams.get("tab") !== "failed";
      const runList =
        onRunsTab && canSeeRuns
          ? clickhouseFactory
              .getClickhouseForOrganization(project.organizationId, "runsList")
              .then((clickhouse) =>
                new NextRunListPresenter($replica, clickhouse).call(
                  project.organizationId,
                  replayEnvironmentId ?? environment.id,
                  {
                    userId: user.id,
                    projectId: project.id,
                    bulkId: data.friendlyId,
                    from: runsFrom,
                    to: runsTo,
                    cursor: url.searchParams.get("cursor") ?? undefined,
                    direction: DirectionSchema.catch("forward").parse(
                      url.searchParams.get("direction") ?? undefined
                    ),
                    columns: getRunColumnsForSelect(request),
                  }
                )
              )
          : Promise.resolve(null);

      // Display flag for the Abort button — the action enforces write:runs.
      const { canAbort } = checkPermissions(ability, {
        canAbort: { action: "write", resource: { type: "runs" } },
      });

      return typeddefer({
        bulkAction: data,
        runList,
        canSeeRuns,
        runsFrom,
        runsTo,
        autoReloadPollIntervalMs,
        canAbort,
      });
    } catch (error) {
      if (error instanceof Response) throw error;
      console.error(error);
      throw new Response(undefined, {
        status: 400,
        statusText: "Something went wrong, if this problem persists please contact support.",
      });
    }
  }
);

export const action = dashboardAction(
  {
    params: BulkActionParamSchema,
    context: (params) => resolveProjectAuthScope(params.organizationSlug, params.projectParam),
    authorization: { action: "write", resource: { type: "runs" } },
  },
  async ({ request, params, user }) => {
    const { organizationSlug, projectParam, envParam, bulkActionParam } = params;

    const project = await findProjectBySlug(organizationSlug, projectParam, user.id);
    if (!project) {
      throw new Response("Not Found", { status: 404 });
    }

    const environment = await findEnvironmentBySlug(project.id, envParam, user.id);
    if (!environment) {
      throw new Response("Not Found", { status: 404 });
    }

    const service = new BulkActionService();
    const [error, _result] = await tryCatch(service.abort(bulkActionParam, environment.id));

    if (error) {
      logger.error("Failed to abort bulk action", {
        error,
      });

      return redirectWithErrorMessage(
        v3BulkActionPath(
          { slug: organizationSlug },
          { slug: projectParam },
          { slug: envParam },
          { friendlyId: bulkActionParam }
        ),
        request,
        `Failed to abort bulk action: ${error.message}`
      );
    }

    return redirectWithSuccessMessage(
      v3BulkActionPath(
        { slug: organizationSlug },
        { slug: projectParam },
        { slug: envParam },
        { friendlyId: bulkActionParam }
      ),
      request,
      "Bulk action aborted"
    );
  }
);

export const handle: Handle = {
  agentPageContext: (data) => bulkActionsAgentPageContext(data),
};

const TABS = ["runs", "failed"] as const;

export default function Page() {
  const {
    bulkAction: loadedBulkAction,
    runList,
    canSeeRuns,
    runsFrom,
    runsTo,
    autoReloadPollIntervalMs,
    canAbort,
  } = useTypedLoaderData<typeof loader>();
  const location = useLocation();
  const cursor = new URLSearchParams(location.search).get("cursor") ?? "";
  const organization = useOrganization();
  const project = useProject();
  const environment = useEnvironment();
  const [tab, setTab, isTabPending] = useDetailTab(TABS);

  const bulkAction = useLiveBulkAction(loadedBulkAction, autoReloadPollIntervalMs);
  const isPending = bulkAction.status === "PENDING";

  const isReplay = bulkAction.type === "REPLAY";
  const title =
    bulkAction.name ||
    `${isReplay ? "Replay" : "Cancel"} of ${simplur`${bulkAction.totalCount} run[|s]`}`;
  const runsEnvironment = bulkAction.replayEnvironment ?? environment;
  // A replay into another environment lists its new runs from there.
  const runsInOtherEnvironment =
    !!bulkAction.replayEnvironment && bulkAction.replayEnvironment.id !== environment.id;
  const { failedItems } = bulkAction;
  const runsListPath = v3RunsPath(organization, project, runsEnvironment, {
    bulkId: bulkAction.friendlyId,
    from: runsFrom,
    to: runsTo,
  });
  const failedLabel = isReplay ? "Failed" : "Not canceled";

  return (
    <PageContainer>
      <NavBar>
        <DetailPageTitle
          title={title}
          backButton={{
            to: v3BulkActionsPath(organization, project, environment),
            text: "Bulk actions",
          }}
        />
      </NavBar>
      <PageBody scrollable={false}>
        <DetailPage
          id="bulk-action"
          header={
            <DetailHeader
              icon={ListCheckedIcon}
              iconClassName="text-bulkActions"
              title={title}
              status={<BulkActionStatusCombo status={bulkAction.status} />}
              meta={[
                <BulkActionTypeCombo
                  key="type"
                  type={bulkAction.type}
                  iconClassName="size-3.5"
                  labelClassName="text-text-dimmed"
                />,
                runCount(bulkAction.totalCount),
                <span key="started">
                  Started <RelativeDateTime date={bulkAction.createdAt} capitalize={false} />
                  {bulkAction.user ? ` by ${bulkAction.user.name}` : ""}
                </span>,
              ]}
              friendlyId={bulkAction.friendlyId}
              secondaryActions={
                <>
                  <LinkButton
                    variant="secondary/small"
                    to={runsListPath}
                    LeadingIcon={RunsIcon}
                    leadingIconClassName="text-runs"
                  >
                    View runs
                  </LinkButton>
                  {/* A cancel replays only the runs it canceled. */}
                  {!isReplay && bulkAction.status !== "PENDING" ? (
                    <LinkButton
                      to={v3CreateBulkActionPath(
                        organization,
                        project,
                        environment,
                        {
                          bulkId: bulkAction.friendlyId,
                          statuses: ["CANCELED"],
                          from: runsFrom,
                          to: runsTo,
                        },
                        "filter",
                        "replay"
                      )}
                      variant="secondary/small"
                      LeadingIcon={ArrowPathIcon}
                      leadingIconClassName="text-indigo-500"
                    >
                      Replay canceled runs
                    </LinkButton>
                  ) : null}
                  {/* A replay's header replays the new runs it created (Eric's call, Nov 17). */}
                  {isReplay && bulkAction.status !== "PENDING" ? (
                    <LinkButton
                      to={v3CreateBulkActionPath(
                        organization,
                        project,
                        runsEnvironment,
                        { bulkId: bulkAction.friendlyId, from: runsFrom, to: runsTo },
                        "filter",
                        "replay"
                      )}
                      variant="secondary/small"
                      LeadingIcon={ArrowPathIcon}
                      leadingIconClassName="text-indigo-500"
                    >
                      Replay new runs
                    </LinkButton>
                  ) : null}
                </>
              }
              primaryAction={
                <ControlledAbortBulkActionDialog
                  disabledReason={
                    bulkAction.status === "COMPLETED"
                      ? "This bulk action has already completed"
                      : bulkAction.status === "ABORTED"
                        ? "This bulk action was already aborted"
                        : !canAbort
                          ? "You don't have permission to abort bulk actions"
                          : undefined
                  }
                  formAction={v3BulkActionPath(organization, project, environment, bulkAction)}
                />
              }
            />
          }
          tabs={
            <DetailTabs
              tabs={[
                {
                  id: "runs",
                  label: isReplay ? "New runs" : "Runs",
                  count: formatNumber(isReplay ? bulkAction.successCount : bulkAction.totalCount),
                },
                // The group's own count: a bulk action from before reasons were recorded has
                // failures and no rows.
                { id: "failed", label: failedLabel, count: formatNumber(bulkAction.failureCount) },
              ]}
              activeTab={tab}
              onTabChange={(next) =>
                setTab(next, { page: undefined, cursor: undefined, direction: undefined })
              }
              layoutId="bulk-action-tab"
            />
          }
          rail={<BulkActionRail bulkAction={bulkAction} runsEnvironment={runsEnvironment} />}
        >
          {tab === "failed" ? (
            <DetailTableTab
              tools={
                isPending ? (
                  <ListUpdatesWhenFinished />
                ) : failedItems.capped ? (
                  <Paragraph variant="extra-small/dimmed" className="truncate">
                    {isReplay
                      ? `Listing the first ${formatNumber(failedItems.recorded)} of ${formatNumber(failedItems.total)} failed runs.`
                      : `Listing ${formatNumber(failedItems.recorded)} of ${formatNumber(failedItems.total)} runs: at most ${formatNumber(failedItems.recordLimit)} failed and ${formatNumber(failedItems.recordLimit)} already finished are kept.`}
                  </Paragraph>
                ) : undefined
              }
              actions={
                failedItems.recorded > 0 ? (
                  <FailedRunsActions failedItems={failedItems} />
                ) : undefined
              }
            >
              <FailedRunsTable
                items={failedItems.items}
                emptyText={
                  isPending && bulkAction.failureCount > 0
                    ? "These runs are listed when the bulk action finishes."
                    : failedItems.recorded === 0 && failedItems.unclassified > 0
                      ? "Reasons weren't recorded for this bulk action."
                      : isReplay
                        ? "No runs failed to replay."
                        : "Every run was canceled."
                }
                stickyHeader
              />
            </DetailTableTab>
          ) : !canSeeRuns ? (
            <DetailTabError
              title="No access to these runs"
              cause="The new runs are in an environment you can't open."
            />
          ) : isTabPending ? (
            <RunsTabSkeleton
              runsListPath={runsListPath}
              rows={bulkAction.totalCount}
              withEnvColumn={runsInOtherEnvironment}
            />
          ) : (
            <DeferredContent
              resolve={runList}
              retainKey={`runs:${cursor}`}
              fallback={
                <RunsTabSkeleton
                  runsListPath={runsListPath}
                  rows={bulkAction.totalCount}
                  withEnvColumn={runsInOtherEnvironment}
                />
              }
              errorElement={
                <DetailTabError
                  title="Couldn't load runs"
                  cause="The runs for this bulk action didn't load. Try again, or open them in the runs list."
                />
              }
            >
              {(list) =>
                list ? (
                  <DetailTableTab
                    tools={isPending ? <ListUpdatesWhenFinished /> : undefined}
                    actions={
                      <>
                        <OpenInRunsList to={runsListPath} />
                        <ListPagination list={list} />
                      </>
                    }
                  >
                    <TaskRunsTable
                      total={list.runs.length}
                      hasFilters={list.hasFilters}
                      filters={list.filters}
                      runs={list.runs}
                      isLoading={false}
                      variant="dimmed"
                      showTopBorder={false}
                      stickyHeader
                      disableAdjacentRows
                      enableSmartColumns={false}
                      environmentColumnVerb={runsInOtherEnvironment ? "Replayed in" : undefined}
                    />
                  </DetailTableTab>
                ) : (
                  <RunsTabSkeleton
                    runsListPath={runsListPath}
                    rows={bulkAction.totalCount}
                    withEnvColumn={runsInOtherEnvironment}
                  />
                )
              }
            </DeferredContent>
          )}
        </DetailPage>
      </PageBody>
    </PageContainer>
  );
}

/**
 * The loader's bulk action with its status and counts kept current while it runs. Only those
 * are polled: the runs list and the failed runs load once, and again when the action finishes.
 */
function useLiveBulkAction(bulkAction: BulkActionData, intervalMs: number): BulkActionData {
  const organization = useOrganization();
  const project = useProject();
  const environment = useEnvironment();
  const fetcher = useTypedFetcher<typeof progressLoader>();
  const revalidator = useRevalidator();
  const isPending = bulkAction.status === "PENDING";
  const path = `/resources/orgs/${organization.slug}/projects/${project.slug}/env/${environment.slug}/bulk-actions/${bulkAction.friendlyId}/progress`;

  useInterval({
    interval: intervalMs,
    onFocus: true,
    onLoad: false,
    disabled: !isPending,
    callback: () => {
      if (fetcher.state === "idle") fetcher.load(path);
    },
  });

  const progress = isPending ? fetcher.data?.progress : undefined;
  const hasFinished = progress !== undefined && progress !== null && progress.status !== "PENDING";
  // Runs on every tick that still says finished, until the loader's own copy catches up.
  useEffect(() => {
    if (hasFinished && revalidator.state === "idle") revalidator.revalidate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasFinished, fetcher.data]);

  if (!progress) return bulkAction;

  const { alreadyFinished, unclassified, ...counts } = progress;
  return {
    ...bulkAction,
    ...counts,
    failedItems: {
      ...bulkAction.failedItems,
      total: counts.failureCount,
      alreadyFinished,
      unclassified,
    },
  };
}

/** Shown in a tab's toolbar while the action runs: its list isn't polled. */
function ListUpdatesWhenFinished() {
  return (
    <Paragraph variant="extra-small/dimmed" className="truncate">
      This list updates when the bulk action finishes.
    </Paragraph>
  );
}

function OpenInRunsList({ to }: { to: string }) {
  return (
    <LinkButton
      variant="tertiary/small"
      to={to}
      LeadingIcon={RunsIcon}
      leadingIconClassName="text-runs"
    >
      Open in runs list
    </LinkButton>
  );
}

/** The runs table's default columns, for the Runs tab skeleton. */
const RUN_SKELETON_COLUMNS = [
  { label: "ID" },
  { label: "Task" },
  { label: "Status" },
  { label: "Version" },
  { label: "Started" },
  { label: "Duration" },
  { label: "Machine" },
];

function RunsTabSkeleton({
  runsListPath,
  rows,
  tools,
  withEnvColumn = false,
}: {
  runsListPath: string;
  rows: number;
  tools?: React.ReactNode;
  /** Matches the table's icon-only Env column, shown first. */
  withEnvColumn?: boolean;
}) {
  return (
    <DetailTableTab tools={tools} actions={<OpenInRunsList to={runsListPath} />}>
      <DetailTabLoading
        columns={withEnvColumn ? [{ label: "Env" }, ...RUN_SKELETON_COLUMNS] : RUN_SKELETON_COLUMNS}
        rows={Math.min(12, Math.max(1, rows))}
      />
    </DetailTableTab>
  );
}

type BulkActionData = UseDataFunctionReturn<typeof loader>["bulkAction"];

function BulkActionMeter({ bulkAction }: { bulkAction: BulkActionData }) {
  const isReplay = bulkAction.type === "REPLAY";
  // A cancel records runs that had already finished as failures; they weren't. One from before
  // reasons were recorded, or past both recording limits, can't tell the two apart.
  const alreadyFinished = isReplay ? 0 : bulkAction.failedItems.alreadyFinished;
  const notCanceled = isReplay ? 0 : bulkAction.failedItems.unclassified;
  const failed = Math.max(0, bulkAction.failureCount - alreadyFinished - notCanceled);

  return (
    <ProgressMeter
      total={bulkAction.totalCount}
      segments={[
        {
          count: bulkAction.successCount,
          label: isReplay ? "replayed successfully" : "canceled",
          className: "bg-success",
        },
        ...(isReplay
          ? []
          : [
              {
                count: alreadyFinished,
                label: "already finished",
                className: "bg-surface-control-hover",
                hideWhenZero: true,
              },
              {
                count: notCanceled,
                label: "not canceled",
                className: "bg-surface-control-hover",
                hideWhenZero: true,
              },
            ]),
        { count: failed, label: "failed", className: "bg-error" },
      ]}
    />
  );
}

/** "1,284 runs", with the count formatted. */
function runCount(count: number) {
  return `${formatNumber(count)} ${count === 1 ? "run" : "runs"}`;
}

function shortDuration(from: Date, to: Date) {
  return formatDurationMilliseconds(Math.max(0, to.getTime() - from.getTime()), {
    style: "short",
  });
}

function BulkActionRail({
  bulkAction,
  runsEnvironment,
}: {
  bulkAction: BulkActionData;
  runsEnvironment: React.ComponentProps<typeof EnvironmentCombo>["environment"];
}) {
  const organization = useOrganization();
  const project = useProject();
  const environment = useEnvironment();
  const isReplay = bulkAction.type === "REPLAY";
  const endedAt =
    bulkAction.status === "ABORTED"
      ? bulkAction.updatedAt
      : bulkAction.status === "COMPLETED"
        ? (bulkAction.completedAt ?? bulkAction.updatedAt)
        : undefined;

  return (
    <PropertyRail>
      <PropertyGroup title="Progress">
        <BulkActionMeter bulkAction={bulkAction} />
      </PropertyGroup>
      <PropertyGroup title="Details">
        <DetailProperty label="ID">
          <CopyableText value={bulkAction.friendlyId} className="font-mono text-xs" />
        </DetailProperty>
        <PropertyPair>
          <DetailProperty label="Status">
            <BulkActionStatusCombo status={bulkAction.status} />
          </DetailProperty>
          <DetailProperty label="Type">
            <BulkActionTypeCombo type={bulkAction.type} />
          </DetailProperty>
        </PropertyPair>
        <DetailProperty label="Created">
          <DateTime date={bulkAction.createdAt} />
        </DetailProperty>
        <DetailProperty label={bulkAction.status === "ABORTED" ? "Aborted" : "Completed"}>
          {endedAt ? <DateTime date={endedAt} /> : "–"}
        </DetailProperty>
        <PropertyPair>
          <DetailProperty label="Duration">
            {endedAt ? shortDuration(new Date(bulkAction.createdAt), new Date(endedAt)) : "–"}
          </DetailProperty>
          <DetailProperty label="Created by">
            {bulkAction.user ? (
              <span className="flex min-w-0 items-center gap-1.5">
                <UserAvatar
                  name={bulkAction.user.name}
                  avatarUrl={bulkAction.user.avatarUrl}
                  className="size-4"
                />
                <span className="truncate">{bulkAction.user.name}</span>
              </span>
            ) : (
              "–"
            )}
          </DetailProperty>
        </PropertyPair>
      </PropertyGroup>
      <PropertyGroup title="Selection">
        <DetailProperty label="Runs">
          {bulkAction.mode === "selected"
            ? `${runCount(bulkAction.totalCount)} selected`
            : `${formatNumber(bulkAction.totalCount)} matching`}
        </DetailProperty>
        {bulkAction.mode === "filter" ? (
          <BulkActionFilterList
            filters={bulkAction.filters}
            runsListPath={v3RunsPath(organization, project, environment, bulkAction.filters)}
          />
        ) : null}
        <DetailProperty label={isReplay ? "Replayed into" : "Environment"}>
          <EnvironmentCombo environment={runsEnvironment} />
        </DetailProperty>
        {isReplay ? (
          <PropertyPair>
            <DetailProperty label="Version">
              {bulkAction.replayVersion === "original" ? (
                "Same as original run"
              ) : bulkAction.replayVersion && !bulkAction.replayEnvironment ? (
                <VersionLabel version={bulkAction.replayVersion} />
              ) : (
                (bulkAction.replayVersion ?? "Current version")
              )}
            </DetailProperty>
            <DetailProperty label="Region">
              {bulkAction.replayRegion ?? "Same as original run"}
            </DetailProperty>
          </PropertyPair>
        ) : null}
      </PropertyGroup>
    </PropertyRail>
  );
}

function ReplayFailedButton({ failedItems }: { failedItems: BulkActionData["failedItems"] }) {
  const organization = useOrganization();
  const project = useProject();
  const environment = useEnvironment();

  if (failedItems.linkRunIds.length === 0) return null;

  const capped = failedItems.total > failedItems.linkRunIds.length;

  return (
    <LinkButton
      variant="secondary/small"
      to={v3CreateBulkActionPath(
        organization,
        project,
        environment,
        // No time range: a run ID filter is bounded by the runs' own creation times.
        { runId: failedItems.linkRunIds },
        "filter",
        "replay"
      )}
      LeadingIcon={ArrowPathIcon}
      leadingIconClassName="text-indigo-500"
    >
      {capped ? `Replay the first ${formatNumber(failedItems.linkRunIds.length)}` : "Replay these"}
    </LinkButton>
  );
}

function FailedRunsActions({ failedItems }: { failedItems: BulkActionData["failedItems"] }) {
  const organization = useOrganization();
  const project = useProject();
  const environment = useEnvironment();

  if (failedItems.recorded === 0) return null;

  return (
    <>
      <LinkButton
        variant="tertiary/small"
        to={v3RunsPath(organization, project, environment, { runId: failedItems.linkRunIds })}
        LeadingIcon={RunsIcon}
        leadingIconClassName="text-runs"
      >
        Open in runs list
      </LinkButton>
      <ReplayFailedButton failedItems={failedItems} />
      <PaginationControls currentPage={failedItems.page} totalPages={failedItems.totalPages} />
    </>
  );
}

function FailedRunsTable({
  items,
  emptyText,
  stickyHeader = false,
}: {
  items: BulkActionData["failedItems"]["items"];
  emptyText: string;
  stickyHeader?: boolean;
}) {
  const organization = useOrganization();
  const project = useProject();
  const environment = useEnvironment();

  return (
    <Table variant="dimmed" showTopBorder={false} stickyHeader={stickyHeader}>
      <TableHeader>
        <TableRow>
          <TableHeaderCell>Run</TableHeaderCell>
          <TableHeaderCell>Task</TableHeaderCell>
          <TableHeaderCell>Reason</TableHeaderCell>
        </TableRow>
      </TableHeader>
      <TableBody>
        {items.length === 0 ? (
          <TableBlankRow colSpan={3}>
            <Paragraph variant="small" className="text-center">
              {emptyText}
            </Paragraph>
          </TableBlankRow>
        ) : (
          items.map((item) => {
            const path = v3RunPath(organization, project, environment, {
              friendlyId: item.runId,
            });
            return (
              <TableRow key={item.runId}>
                <TableCell to={path}>
                  <span className="font-mono text-xs">{item.runId}</span>
                </TableCell>
                <TableCell to={path}>{item.taskIdentifier ?? "–"}</TableCell>
                <TableCell to={path} className="text-text-dimmed">
                  <span className="whitespace-normal">{item.error}</span>
                </TableCell>
              </TableRow>
            );
          })
        )}
      </TableBody>
    </Table>
  );
}

function ControlledAbortBulkActionDialog({
  disabledReason,
  formAction,
}: {
  /** Shown as the disabled button's tooltip. */
  disabledReason?: string;
  formAction: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button
          variant="danger/small"
          LeadingIcon={NoSymbolIcon}
          disabled={disabledReason !== undefined}
          tooltip={disabledReason}
        >
          Abort…
        </Button>
      </DialogTrigger>
      <AbortBulkActionDialog formAction={formAction} onAbortSubmitted={() => setOpen(false)} />
    </Dialog>
  );
}
