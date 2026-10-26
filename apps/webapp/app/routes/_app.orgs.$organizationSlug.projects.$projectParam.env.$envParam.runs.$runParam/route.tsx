import {
  ArrowUturnLeftIcon,
  BookOpenIcon,
  InformationCircleIcon,
  LockOpenIcon,
  StopCircleIcon,
} from "@heroicons/react/20/solid";

import { useLoaderData, useRevalidator } from "@remix-run/react";
import { type LoaderFunctionArgs, type SerializeFrom, json } from "@remix-run/server-runtime";
import { tryCatch } from "@trigger.dev/core/v3";
import { useState } from "react";
import { redirect } from "remix-typedjson";
import { ChevronExtraSmallDown } from "~/assets/icons/ChevronExtraSmallDown";
import { ChevronExtraSmallUp } from "~/assets/icons/ChevronExtraSmallUp";
import { DevDisconnectedBanner, useCrossEngineIsConnected } from "~/components/DevPresence";
import { AdminDebugTooltip } from "~/components/admin/debugTooltip";
import { PageBody } from "~/components/layout/AppLayout";
import { Button, LinkButton } from "~/components/primitives/Buttons";
import { CopyableText } from "~/components/primitives/CopyableText";
import { Dialog, DialogTrigger } from "~/components/primitives/Dialog";
import { InfoPanel } from "~/components/primitives/InfoPanel";
import { NavBar, PageAccessories, PageTitle } from "~/components/primitives/PageHeader";
import { Paragraph } from "~/components/primitives/Paragraph";
import * as Property from "~/components/primitives/PropertyTable";
import {
  RESIZABLE_PANEL_ANIMATION,
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
  type ResizableSnapshot,
  collapsibleHandleClassName,
  useFrozenValue,
} from "~/components/primitives/Resizable";
import { CancelRunDialog } from "~/components/runs/v3/CancelRunDialog";
import { ReplayRunDialog } from "~/components/runs/v3/ReplayRunDialog";
import { getRunFiltersFromSearchParams } from "~/components/runs/v3/RunFilters";
import { resizableSettings } from "~/components/runs/v3/trace/resizableSettings";
import { RunRelationshipsHeader } from "~/components/runs/v3/trace/ShowParentOrRootLinks";
import { TasksTreeView } from "~/components/runs/v3/trace/TasksTreeView";
import {
  AdjacentRunsShortcuts,
  ShortcutWithAction,
} from "~/components/runs/v3/trace/TraceShortcuts";
import { TraceStatusIndicator } from "~/components/runs/v3/trace/TraceStatusIndicator";
import { type RunTraceInput, useRunTrace } from "~/components/runs/v3/trace/useRunTrace";
import { RunToolbar, TraceFilters } from "~/components/runs/v3/trace/TraceToolbar";
import { $replica } from "~/db.server";
import { useDebounce } from "~/hooks/useDebounce";
import { useEnvironment } from "~/hooks/useEnvironment";
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
import { useReplaceSearchParams } from "~/hooks/useReplaceSearchParams";
import { useSearchParams } from "~/hooks/useSearchParam";
import { env } from "~/env.server";
import { findProjectBySlug, findProjectWithOrgFlagsBySlug } from "~/models/project.server";
import { findEnvironmentBySlug } from "~/models/runtimeEnvironment.server";
import { NextRunListPresenter } from "~/presenters/v3/NextRunListPresenter.server";
import {
  RunEnvironmentMismatchError,
  RunNotInPgError,
  RunPresenter,
} from "~/presenters/v3/RunPresenter.server";
import { findRunByIdWithMollifierFallback } from "~/v3/mollifier/readFallback.server";
import { buildSyntheticRunHeader } from "~/v3/mollifier/syntheticRunHeader.server";
import { buildSyntheticTraceForBufferedRun } from "~/v3/mollifier/syntheticTrace.server";
import { clickhouseFactory } from "~/services/clickhouse/clickhouseFactoryInstance.server";
import { logger } from "~/services/logger.server";
import { getResizableSnapshot } from "~/services/resizablePanel.server";
import { requireUser } from "~/services/session.server";
import { rbac } from "~/services/rbac.server";
import { runAgentPageContext } from "~/components/dashboard-agent/suggested-prompts";
import { isFinalRunStatus } from "~/v3/taskStatus";
import { RunCreateAlertButton } from "./RunCreateAlertButton";
import { WhenAgentUnavailable } from "~/components/dashboard-agent/WhenAgentUnavailable";
import { cn } from "~/utils/cn";
import type { Handle } from "~/utils/handle";
import {
  docsPath,
  v3BillingPath,
  v3RunParamsSchema,
  v3RunPath,
  v3RunRedirectPath,
  v3RunSpanPath,
  v3RunsPath,
} from "~/utils/pathBuilder";
import { canUseAlertsList } from "~/v3/canUseAlertsList.server";
import type { SpanOverride } from "~/v3/eventRepository/eventRepository.types";
import { useCurrentPlan } from "../_app.orgs.$organizationSlug/route";
import { shouldRevalidateRunPage } from "./shouldRevalidateRunPage";
import { SpanView } from "../resources.orgs.$organizationSlug.projects.$projectParam.env.$envParam.runs.$runParam.spans.$spanParam/route";
import { pageMeta } from "~/utils/pageTitle";

export const meta = pageMeta(({ params }) => [params.runParam ?? "Run", "Runs"]);

type TraceEvent = NonNullable<SerializeFrom<typeof loader>["trace"]>["events"][0];

type RunsListNavigation = {
  runs: Array<{ friendlyId: string; spanId: string }>;
  pagination: { next?: string; previous?: string };
  prevPageLastRun?: { friendlyId: string; spanId: string; cursor: string };
  nextPageFirstRun?: { friendlyId: string; spanId: string; cursor: string };
};

async function getRunsListFromTableState({
  tableStateParam,
  organizationSlug,
  projectParam,
  envParam,
  runParam,
  userId,
}: {
  tableStateParam: string | null;
  organizationSlug: string;
  projectParam: string;
  envParam: string;
  runParam: string;
  userId: string;
}): Promise<RunsListNavigation | null> {
  if (!tableStateParam) {
    return null;
  }

  try {
    const tableStateSearchParams = new URLSearchParams(decodeURIComponent(tableStateParam));
    const filters = getRunFiltersFromSearchParams(tableStateSearchParams);

    const project = await findProjectBySlug(organizationSlug, projectParam, userId);
    const environment = await findEnvironmentBySlug(project?.id ?? "", envParam, userId);

    if (!project || !environment) {
      return null;
    }

    const clickhouse = await clickhouseFactory.getClickhouseForOrganization(
      project.organizationId,
      "runsList"
    );
    const runsListPresenter = new NextRunListPresenter($replica, clickhouse);
    const currentPageResult = await runsListPresenter.call(project.organizationId, environment.id, {
      userId,
      projectId: project.id,
      ...filters,
      pageSize: 25, // Load enough runs to provide navigation context
    });

    const runsList: RunsListNavigation = {
      runs: currentPageResult.runs,
      pagination: currentPageResult.pagination,
    };

    const currentRunIndex = currentPageResult.runs.findIndex((r) => r.friendlyId === runParam);

    if (currentRunIndex === 0 && currentPageResult.pagination.previous) {
      const prevPageResult = await runsListPresenter.call(project.organizationId, environment.id, {
        userId,
        projectId: project.id,
        ...filters,
        cursor: currentPageResult.pagination.previous,
        direction: "backward",
        pageSize: 1, // We only need the last run from the previous page
      });

      if (prevPageResult.runs.length > 0) {
        runsList.prevPageLastRun = {
          friendlyId: prevPageResult.runs[0].friendlyId,
          spanId: prevPageResult.runs[0].spanId,
          cursor: currentPageResult.pagination.previous,
        };
      }
    }

    if (
      currentRunIndex === currentPageResult.runs.length - 1 &&
      currentPageResult.pagination.next
    ) {
      const nextPageResult = await runsListPresenter.call(project.organizationId, environment.id, {
        userId,
        projectId: project.id,
        ...filters,
        cursor: currentPageResult.pagination.next,
        direction: "forward",
        pageSize: 1, // We only need the first run from the next page
      });

      if (nextPageResult.runs.length > 0) {
        runsList.nextPageFirstRun = {
          friendlyId: nextPageResult.runs[0].friendlyId,
          spanId: nextPageResult.runs[0].spanId,
          cursor: currentPageResult.pagination.next,
        };
      }
    }

    return runsList;
  } catch (error) {
    logger.error("Error loading runs list from tableState:", { error, organizationSlug });
    return null;
  }
}

// Display-only write:runs flags for the Replay/Cancel controls. The cancel
// and replay action routes enforce write:runs independently; this mirrors the
// result so the buttons disable for roles that lack it. Permissive in OSS.
async function runWritePermissions(request: Request, userId: string, organizationId: string) {
  const auth = await rbac.authenticateSession(request, { userId, organizationId });
  const canWriteRun = auth.ok ? auth.ability.can("write", { type: "runs" }) : true;
  return { canReplayRun: canWriteRun, canCancelRun: canWriteRun };
}

async function runAlertsEnabled(userId: string, organizationSlug: string, projectParam: string) {
  const project = await findProjectWithOrgFlagsBySlug(organizationSlug, projectParam, userId);
  const alertsEnabled = project
    ? await canUseAlertsList({
        orgFeatureFlags: (project.organization.featureFlags as Record<string, unknown>) ?? {},
        userId,
      })
    : false;
  return { alertsEnabled };
}

export { shouldRevalidateRunPage as shouldRevalidate };

export const handle: Handle = {
  agentPageContext: (data) => runAgentPageContext(data),
};

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const user = await requireUser(request);
  const userId = user.id;
  const { projectParam, organizationSlug, envParam, runParam } = v3RunParamsSchema.parse(params);

  const url = new URL(request.url);
  // Same rule as the trace-chunk route, so the first chunk and later chunks agree.
  const showDebug =
    url.searchParams.get("showDebug") === "true" && (user.admin || user.isImpersonating);
  const selectedSpanId = url.searchParams.get("span") ?? undefined;

  const presenter = new RunPresenter();
  const [error, result] = await tryCatch(
    presenter.call({
      userId,
      showDeletedLogs: user.isImpersonating,
      projectSlug: projectParam,
      runFriendlyId: runParam,
      environmentSlug: envParam,
      showDebug,
      selectedSpanId,
    })
  );

  if (error) {
    if (error instanceof RunEnvironmentMismatchError) {
      throw redirect(
        v3RunRedirectPath(
          { slug: organizationSlug },
          { slug: projectParam },
          { friendlyId: runParam }
        )
      );
    }

    // Only fall back to the mollifier buffer on a genuine PG miss. Any
    // other error (DB timeout during trace queries, event-repository
    // failure, etc.) means the run WAS in PG but a downstream lookup
    // failed — falling back to the buffer here would either return a
    // stale synth entry if one happens to exist in the brief drainer-
    // materialisation race window, or quietly mask the real failure.
    // `RunNotInPgError` is the typed signal RunPresenter throws for the
    // route loader's specific case (`RunPresenter.server.ts:130`).
    if (!(error instanceof RunNotInPgError)) {
      throw error;
    }

    // PG miss → try the mollifier buffer. When the gate diverts a trigger
    // the run sits in Redis until the drainer materialises it; without
    // this fallback the run-detail page 404s for the brief buffered window
    // even though the API has accepted the trigger and returned an id.
    const buffered = await tryMollifiedRunFallback({
      runFriendlyId: runParam,
      organizationSlug,
      projectSlug: projectParam,
      envSlug: envParam,
      userId,
    });

    if (buffered) {
      // Preselect the root span on the initial page load when the URL
      // doesn't already carry `?span=`. The sibling redirect routes
      // (runs.$runParam.ts, @.runs.$runParam.ts,
      // projects.v3.$projectRef.runs.$runParam.ts) all do this, but
      // direct navigation to the canonical project-scoped URL never
      // hit those redirects — leaving the right detail panel collapsed.
      // Skip on `_data` requests (Remix data fetches): they're
      // client-driven follow-ups and the client URL is what matters,
      // not the loader's view of it.
      if (!url.searchParams.has("span") && !url.searchParams.has("_data") && buffered.run.spanId) {
        url.searchParams.set("span", buffered.run.spanId);
        throw redirect(url.pathname + "?" + url.searchParams.toString());
      }

      const parent = await getResizableSnapshot(request, resizableSettings.parent.autosaveId);
      const tree = await getResizableSnapshot(request, resizableSettings.tree.autosaveId);

      return json({
        run: buffered.run,
        trace: buffered.trace,
        maximumLiveReloadingSetting: env.MAXIMUM_LIVE_RELOADING_EVENTS,
        resizable: { parent, tree },
        runsList: null,
        ...(await runWritePermissions(request, userId, buffered.run.environment.organizationId)),
        ...(await runAlertsEnabled(userId, organizationSlug, projectParam)),
      });
    }

    throw error;
  }

  // Preselect the root span on the initial page load when the URL
  // doesn't already carry `?span=`. See the comment on the equivalent
  // block in the buffered fallback above — the sibling redirect routes
  // do this, but direct navigation to the canonical project-scoped URL
  // never hits them, leaving the right detail panel collapsed.
  if (!url.searchParams.has("span") && !url.searchParams.has("_data") && result.run.spanId) {
    url.searchParams.set("span", result.run.spanId);
    throw redirect(url.pathname + "?" + url.searchParams.toString());
  }

  //resizable settings
  const parent = await getResizableSnapshot(request, resizableSettings.parent.autosaveId);
  const tree = await getResizableSnapshot(request, resizableSettings.tree.autosaveId);

  const runsList = await getRunsListFromTableState({
    tableStateParam: url.searchParams.get("tableState"),
    organizationSlug,
    projectParam,
    envParam,
    runParam,
    userId,
  });

  return json({
    run: result.run,
    trace: result.trace,
    maximumLiveReloadingSetting: result.maximumLiveReloadingSetting,
    resizable: {
      parent,
      tree,
    },
    runsList,
    ...(await runWritePermissions(request, userId, result.run.environment.organizationId)),
    ...(await runAlertsEnabled(userId, organizationSlug, projectParam)),
  });
};

async function tryMollifiedRunFallback(args: {
  runFriendlyId: string;
  organizationSlug: string;
  projectSlug: string;
  envSlug: string;
  userId: string;
}) {
  const project = await findProjectBySlug(args.organizationSlug, args.projectSlug, args.userId);
  if (!project) return null;
  const environment = await findEnvironmentBySlug(project.id, args.envSlug, args.userId);
  if (!environment) return null;

  const buffered = await findRunByIdWithMollifierFallback({
    runId: args.runFriendlyId,
    environmentId: environment.id,
    organizationId: project.organizationId,
  });
  if (!buffered) return null;

  return {
    run: buildSyntheticRunHeader({
      run: buffered,
      environment: {
        id: environment.id,
        organizationId: project.organizationId,
        type: environment.type,
        slug: environment.slug,
      },
    }),
    trace: buildSyntheticTraceForBufferedRun(buffered),
  };
}

type LoaderData = SerializeFrom<typeof loader>;

export default function Page() {
  const {
    run,
    trace,
    maximumLiveReloadingSetting,
    runsList,
    resizable,
    canReplayRun,
    canCancelRun,
    alertsEnabled,
  } = useLoaderData<typeof loader>();
  const organization = useOrganization();
  const project = useProject();
  const environment = useEnvironment();
  const isConnected = useCrossEngineIsConnected({
    logCount: trace?.events.length ?? 0,
    isCompleted: run.finishedAt !== null,
  });
  const { value } = useSearchParams();
  const tableState = decodeURIComponent(value("tableState") ?? "");
  const tableStateSearchParams = new URLSearchParams(tableState);
  const filters = getRunFiltersFromSearchParams(tableStateSearchParams);
  const tabParam = value("tab") ?? undefined;
  const spanParam = value("span") ?? undefined;

  const [previousRunPath, nextRunPath] = useAdjacentRunPaths({
    organization,
    project,
    environment,
    tableState,
    run,
    runsList,
    tabParam,
    useSpan: !!spanParam,
  });

  const runActions = (
    <>
      {run.isFinished ? null : (
        <ControlledCancelRunDialog
          key={`cancel-${run.friendlyId}`}
          canCancel={canCancelRun}
          runFriendlyId={run.friendlyId}
          redirectPath={v3RunSpanPath(
            organization,
            project,
            environment,
            { friendlyId: run.friendlyId },
            { spanId: run.spanId }
          )}
        />
      )}
      <Dialog key={`replay-${run.friendlyId}`}>
        <DialogTrigger asChild>
          <Button
            variant="secondary/small"
            LeadingIcon={ArrowUturnLeftIcon}
            shortcut={{ key: "R" }}
            className="pr-2"
            disabled={!canReplayRun}
            tooltip={canReplayRun ? undefined : "You don't have permission to replay runs"}
          >
            Replay run
          </Button>
        </DialogTrigger>
        <ReplayRunDialog
          runFriendlyId={run.friendlyId}
          failedRedirect={v3RunSpanPath(
            organization,
            project,
            environment,
            { friendlyId: run.friendlyId },
            { spanId: run.spanId }
          )}
        />
      </Dialog>
    </>
  );

  return (
    <>
      <NavBar>
        <PageTitle
          backButton={{
            to: v3RunsPath(organization, project, environment, filters),
            text: "Runs",
          }}
          title={
            <div className="flex items-center gap-x-0">
              <CopyableText
                value={run.friendlyId}
                variant="text-below"
                className="-ml-1.75 h-6 px-1.5 font-mono text-xs hover:text-text-bright"
              />
              {tableState && (
                <div className="flex">
                  <PreviousRunButton to={previousRunPath} />
                  <NextRunButton to={nextRunPath} />
                </div>
              )}
            </div>
          }
        />
        {environment.type === "DEVELOPMENT" && <DevDisconnectedBanner isConnected={isConnected} />}
        <PageAccessories>
          <AdminDebugTooltip>
            <Property.Table>
              <Property.Item>
                <Property.Label>ID</Property.Label>
                <Property.Value>
                  <CopyableText value={run.id} asChild hideTooltip />
                </Property.Value>
              </Property.Item>
              <Property.Item>
                <Property.Label>Trace ID</Property.Label>
                <Property.Value>
                  <CopyableText value={run.traceId} asChild hideTooltip />
                </Property.Value>
              </Property.Item>
              <Property.Item>
                <Property.Label>Env ID</Property.Label>
                <Property.Value>
                  <CopyableText value={run.environment.id} asChild hideTooltip />
                </Property.Value>
              </Property.Item>
              <Property.Item>
                <Property.Label>Org ID</Property.Label>
                <Property.Value>
                  <CopyableText value={run.environment.organizationId} asChild hideTooltip />
                </Property.Value>
              </Property.Item>
            </Property.Table>
          </AdminDebugTooltip>
          <WhenAgentUnavailable>
            <LinkButton variant={"docs/small"} LeadingIcon={BookOpenIcon} to={docsPath("/runs")}>
              Run docs
            </LinkButton>
          </WhenAgentUnavailable>
          {alertsEnabled && !isFinalRunStatus(run.status) ? (
            <RunCreateAlertButton
              taskIdentifier={run.taskIdentifier}
              organization={organization}
              project={project}
              environment={environment}
            />
          ) : null}
        </PageAccessories>
      </NavBar>
      <PageBody scrollable={false}>
        {trace ? (
          <TraceView
            key={run.friendlyId}
            run={run}
            trace={trace}
            maximumLiveReloadingSetting={maximumLiveReloadingSetting}
            resizable={resizable}
            actions={runActions}
          />
        ) : (
          <NoLogsView run={run} resizable={resizable} actions={runActions} />
        )}
      </PageBody>
    </>
  );
}

type TraceViewProps = Pick<LoaderData, "run" | "maximumLiveReloadingSetting" | "resizable"> & {
  trace: NonNullable<LoaderData["trace"]>;
  actions: React.ReactNode;
};

function TraceView({
  run,
  trace,
  maximumLiveReloadingSetting,
  resizable,
  actions,
}: TraceViewProps) {
  const { searchParams, replaceSearchParam } = useReplaceSearchParams();
  const { value: debugValue, replace: replaceDebug } = useSearchParams();
  const selectedSpanId = searchParams.get("span") ?? undefined;
  const frozenSpanId = useFrozenValue(selectedSpanId);
  const displaySpanId = selectedSpanId ?? frozenSpanId;

  const { queuedDuration } = trace;

  const [errorsOnly, setErrorsOnly] = useState(false);
  const [filterText, setFilterText] = useState("");
  const [showQueueTime, setShowQueueTime] = useState(false);

  // The revalidator's identity is unstable; useRunTrace reads the callback from a ref.
  const revalidator = useRevalidator();
  const {
    events,
    duration,
    rootSpanStatus,
    rootStartedAt,
    overridesBySpanId,
    linkedRunIdBySpanId,
    traceStatus,
    retryLoad,
    inspectorRefreshKey,
  } = useRunTrace({
    run,
    trace: trace as unknown as RunTraceInput,
    errorsOnly,
    maximumLiveReloadingSetting,
    onRunDataStale: () => revalidator.revalidate(),
  });

  const changeToSpan = useDebounce((selectedSpan: string) => {
    replaceSearchParam("span", selectedSpan, { replace: true });
  }, 250);

  // Frozen while the panel is closed, so closing doesn't reload it and reopening catches up.
  const displayRefreshKey = useFrozenValue(selectedSpanId ? inspectorRefreshKey : undefined);

  const spanOverrides = selectedSpanId ? overridesBySpanId?.[selectedSpanId] : undefined;
  const frozenSpanOverrides = useFrozenValue(spanOverrides);
  const displaySpanOverrides = selectedSpanId ? spanOverrides : frozenSpanOverrides;

  // Get the linked run ID for cached spans (map updated as chunks assemble)
  const selectedSpanLinkedRunId = selectedSpanId
    ? linkedRunIdBySpanId?.[selectedSpanId]
    : undefined;
  const frozenLinkedRunId = useFrozenValue(selectedSpanLinkedRunId);
  const displayLinkedRunId =
    (selectedSpanId ? selectedSpanLinkedRunId : frozenLinkedRunId) ?? undefined;

  return (
    <div className="grid h-full max-h-full grid-cols-[minmax(0,1fr)] grid-rows-[auto_1fr] overflow-hidden">
      <RunToolbar
        filters={
          <TraceFilters
            onFilterTextChange={setFilterText}
            showQueueTime={showQueueTime}
            onShowQueueTimeChange={setShowQueueTime}
            errorsOnly={errorsOnly}
            onErrorsOnlyChange={setErrorsOnly}
            debug={{
              checked: debugValue("showDebug") === "true",
              onChange: (checked) => replaceDebug({ showDebug: checked ? "true" : "false" }),
            }}
          />
        }
        status={
          <TraceStatusIndicator key={run.friendlyId} status={traceStatus} onRetry={retryLoad} />
        }
        actions={actions}
      />
      <ResizablePanelGroup
        autosaveId={resizableSettings.parent.autosaveId}
        snapshot={resizable.parent as ResizableSnapshot}
        className="h-full max-h-full min-h-0"
      >
        <ResizablePanel
          id={resizableSettings.parent.main.id}
          min={resizableSettings.parent.main.min}
        >
          <div className="flex h-full flex-col overflow-hidden">
            <div className="min-h-0 flex-1">
              <TasksTreeView
                selectedId={selectedSpanId}
                key={events[0]?.id ?? "-"}
                events={events as unknown as TraceEvent[]}
                onSelectedIdChanged={(selectedSpan) => {
                  //instantly close the panel if no span is selected
                  if (!selectedSpan) {
                    replaceSearchParam("span");
                    return;
                  }

                  changeToSpan(selectedSpan);
                }}
                totalDuration={duration}
                rootSpanStatus={rootSpanStatus}
                rootStartedAt={rootStartedAt ? new Date(rootStartedAt) : undefined}
                queuedDuration={queuedDuration}
                environmentType={run.environment.type}
                header={
                  <RunRelationshipsHeader rootRun={run.rootTaskRun} parentRun={run.parentTaskRun} />
                }
                showRootBadge={!run.rootTaskRun}
                shortcutHints={{
                  afterNavigation: <AdjacentRunsShortcuts />,
                  trailing: (
                    <ShortcutWithAction
                      shortcut={{ key: "Q" }}
                      title="Queue time"
                      action={() => {}}
                    />
                  ),
                }}
                isCompleted={run.finishedAt !== null}
                treeSnapshot={resizable.tree as ResizableSnapshot}
                errorsOnly={errorsOnly}
                filterText={filterText}
                showQueueTime={showQueueTime}
              />
            </div>
          </div>
        </ResizablePanel>
        <ResizableHandle
          id={resizableSettings.parent.handleId}
          className={collapsibleHandleClassName(!!selectedSpanId)}
        />
        <ResizablePanel
          id={resizableSettings.parent.inspector.id}
          default={resizableSettings.parent.inspector.default}
          min={resizableSettings.parent.inspector.min}
          className="overflow-hidden"
          collapsible
          collapsed={!selectedSpanId}
          onCollapseChange={() => {}}
          collapsedSize="0px"
          collapseAnimation={RESIZABLE_PANEL_ANIMATION}
        >
          <div
            className="h-full"
            style={{ minWidth: parseInt(resizableSettings.parent.inspector.min) }}
          >
            {displaySpanId && (
              <SpanView
                runParam={run.friendlyId}
                spanId={displaySpanId}
                spanOverrides={displaySpanOverrides as SpanOverride | undefined}
                closePanel={() => replaceSearchParam("span")}
                linkedRunId={displayLinkedRunId}
                refreshKey={displayRefreshKey ?? undefined}
              />
            )}
          </div>
        </ResizablePanel>
      </ResizablePanelGroup>
    </div>
  );
}

// Controlled wrapper around the cancel dialog. Owns the Radix open state
// so the dialog closes itself once the cancel action transitions through
// submission. We can't `<DialogClose asChild>`-wrap the submit button
// because Radix's onClick handler swallows the button's name=value pair
// that the form action depends on for `redirectUrl`.
function ControlledCancelRunDialog({
  runFriendlyId,
  redirectPath,
  canCancel,
}: {
  runFriendlyId: string;
  redirectPath: string;
  canCancel: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button
          variant="danger/small"
          LeadingIcon={StopCircleIcon}
          shortcut={{ key: "C" }}
          disabled={!canCancel}
          tooltip={canCancel ? undefined : "You don't have permission to cancel runs"}
        >
          Cancel run…
        </Button>
      </DialogTrigger>
      <CancelRunDialog
        runFriendlyId={runFriendlyId}
        redirectPath={redirectPath}
        onCancelSubmitted={() => setOpen(false)}
      />
    </Dialog>
  );
}

function NoLogsView({
  run,
  resizable,
  actions,
}: Pick<LoaderData, "run" | "resizable"> & { actions: React.ReactNode }) {
  const plan = useCurrentPlan();
  const organization = useOrganization();

  const logRetention = plan?.v3Subscription?.plan?.limits.logRetentionDays.number ?? 30;

  const finishedAt = run.finishedAt ? new Date(run.finishedAt) : undefined;
  const now = new Date();

  const daysSinceCompleted = finishedAt
    ? Math.floor((now.getTime() - finishedAt.getTime()) / (1000 * 60 * 60 * 24))
    : undefined;

  const isWithinLogRetention =
    daysSinceCompleted !== undefined && daysSinceCompleted <= logRetention;

  return (
    <div className="grid h-full max-h-full grid-cols-[minmax(0,1fr)] grid-rows-[auto_1fr] overflow-hidden">
      <RunToolbar actions={actions} />
      <ResizablePanelGroup
        autosaveId={resizableSettings.parent.autosaveId}
        snapshot={resizable.parent as ResizableSnapshot}
        className="h-full max-h-full min-h-0"
      >
        <ResizablePanel
          id={resizableSettings.parent.main.id}
          min={resizableSettings.parent.main.min}
        >
          <div className="grid h-full place-items-center">
            {daysSinceCompleted === undefined ? (
              // NoLogsView only renders when the loader returns no trace.
              // Buffered runs always carry a synthetic trace (see
              // buildSyntheticTraceForBufferedRun) so they never reach
              // this branch — the message here is the pre-mollifier
              // copy for runs with no finished time and no logs.
              <InfoPanel variant="info" icon={InformationCircleIcon} title="We delete old logs">
                <Paragraph variant="small">
                  We tidy up older logs to keep things running smoothly.
                </Paragraph>
              </InfoPanel>
            ) : isWithinLogRetention ? (
              <InfoPanel
                variant="info"
                icon={InformationCircleIcon}
                title="These logs have been deleted"
              >
                <Paragraph variant="small">
                  Your log retention is {logRetention} days but these logs had already been deleted.
                  From now on only logs from runs that completed {logRetention} days ago will be
                  deleted.
                </Paragraph>
              </InfoPanel>
            ) : daysSinceCompleted <= 30 ? (
              <InfoPanel
                variant="upgrade"
                icon={LockOpenIcon}
                iconClassName="text-indigo-500"
                title="Unlock longer log retention"
                accessory={
                  <LinkButton to={v3BillingPath(organization)} variant="secondary/small">
                    Upgrade
                  </LinkButton>
                }
              >
                <Paragraph variant="small">
                  The logs for this run have been deleted because the run completed{" "}
                  {daysSinceCompleted} days ago.
                </Paragraph>
                <Paragraph variant="small">Upgrade your plan to keep logs for longer.</Paragraph>
              </InfoPanel>
            ) : (
              <InfoPanel
                variant="info"
                icon={InformationCircleIcon}
                title="These logs are more than 30 days old"
              >
                <Paragraph variant="small">
                  We tidy up older logs to keep things running smoothly.
                </Paragraph>
              </InfoPanel>
            )}
          </div>
        </ResizablePanel>
        <ResizableHandle id={resizableSettings.parent.handleId} />
        <ResizablePanel
          id={resizableSettings.parent.inspector.id}
          default={resizableSettings.parent.inspector.default}
          min={resizableSettings.parent.inspector.min}
          isStaticAtRest
        >
          <SpanView runParam={run.friendlyId} spanId={run.spanId} />
        </ResizablePanel>
      </ResizablePanelGroup>
    </div>
  );
}

function useAdjacentRunPaths({
  organization,
  project,
  environment,
  tableState,
  run,
  runsList,
  tabParam,
  useSpan,
}: {
  organization: { slug: string };
  project: { slug: string };
  environment: { slug: string };
  tableState: string;
  run: { friendlyId: string; spanId: string };
  runsList: RunsListNavigation | null;
  tabParam?: string;
  useSpan?: boolean;
}): [string | null, string | null] {
  if (!runsList || runsList.runs.length === 0) {
    return [null, null];
  }

  const currentIndex = runsList.runs.findIndex((r) => r.friendlyId === run.friendlyId);

  if (currentIndex === -1) {
    return [null, null];
  }

  // Determine previous run: use prevPageLastRun if at first position, otherwise use previous run in list
  let previousRun: { friendlyId: string; spanId: string } | null = null;
  const previousRunTableState = new URLSearchParams(tableState);
  if (currentIndex > 0) {
    previousRun = runsList.runs[currentIndex - 1];
  } else if (runsList.prevPageLastRun) {
    previousRun = runsList.prevPageLastRun;
    // Update tableState with the new cursor for the previous page
    previousRunTableState.set("cursor", runsList.prevPageLastRun.cursor);
    previousRunTableState.set("direction", "backward");
  }

  // Determine next run: use nextPageFirstRun if at last position, otherwise use next run in list
  let nextRun: { friendlyId: string; spanId: string } | null = null;
  const nextRunTableState = new URLSearchParams(tableState);
  if (currentIndex < runsList.runs.length - 1) {
    nextRun = runsList.runs[currentIndex + 1];
  } else if (runsList.nextPageFirstRun) {
    nextRun = runsList.nextPageFirstRun;
    // Update tableState with the new cursor for the next page
    nextRunTableState.set("cursor", runsList.nextPageFirstRun.cursor);
    nextRunTableState.set("direction", "forward");
  }

  const previousURLSearchParams = new URLSearchParams();
  previousURLSearchParams.set("tableState", previousRunTableState.toString());
  if (previousRun && useSpan) {
    previousURLSearchParams.set("span", previousRun.spanId);
  }
  if (tabParam && useSpan) {
    previousURLSearchParams.set("tab", tabParam);
  }
  const previousRunPath = previousRun
    ? v3RunPath(organization, project, environment, previousRun, previousURLSearchParams)
    : null;

  const nextURLSearchParams = new URLSearchParams();
  nextURLSearchParams.set("tableState", nextRunTableState.toString());
  if (nextRun && useSpan) {
    nextURLSearchParams.set("span", nextRun.spanId);
  }
  if (tabParam && useSpan) {
    nextURLSearchParams.set("tab", tabParam);
  }
  const nextRunPath = nextRun
    ? v3RunPath(organization, project, environment, nextRun, nextURLSearchParams)
    : null;

  return [previousRunPath, nextRunPath];
}

function PreviousRunButton({ to }: { to: string | null }) {
  return (
    <div className={cn("peer/prev order-1", !to && "pointer-events-none")}>
      <LinkButton
        to={to ? to : "#"}
        variant={"minimal/small"}
        LeadingIcon={ChevronExtraSmallUp}
        leadingIconClassName="size-3 group-hover/button:text-text-bright transition-colors"
        className={cn("flex size-6 max-w-6 items-center", !to && "cursor-not-allowed opacity-50")}
        onClick={(e) => !to && e.preventDefault()}
        shortcut={{ key: "j" }}
        tooltip="Previous Run"
        disabled={!to}
        replace
      />
    </div>
  );
}

function NextRunButton({ to }: { to: string | null }) {
  return (
    <div className={cn("peer/next order-3", !to && "pointer-events-none")}>
      <LinkButton
        to={to ? to : "#"}
        variant={"minimal/small"}
        LeadingIcon={ChevronExtraSmallDown}
        leadingIconClassName="size-3 group-hover/button:text-text-bright transition-colors"
        className={cn("flex size-6 max-w-6 items-center", !to && "cursor-not-allowed opacity-50")}
        onClick={(e) => !to && e.preventDefault()}
        shortcut={{ key: "k" }}
        tooltip="Next Run"
        disabled={!to}
        replace
      />
    </div>
  );
}
