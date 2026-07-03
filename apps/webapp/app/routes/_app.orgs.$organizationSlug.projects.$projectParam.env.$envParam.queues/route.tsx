import {
  AdjustmentsHorizontalIcon,
  ArrowUpCircleIcon,
  BookOpenIcon,
  PauseIcon,
  PlayIcon,
  RectangleStackIcon,
} from "@heroicons/react/20/solid";
import { DialogClose } from "@radix-ui/react-dialog";
import { Form, Link, useNavigation, useSearchParams, type MetaFunction } from "@remix-run/react";
import { type ActionFunctionArgs, type LoaderFunctionArgs } from "@remix-run/server-runtime";
import type { QueueItem } from "@trigger.dev/core/v3/schemas";
import type { RuntimeEnvironmentType } from "@trigger.dev/database";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { z } from "zod";
import { ConcurrencyIcon } from "~/assets/icons/ConcurrencyIcon";
import { RunsIcon } from "~/assets/icons/RunsIcon";
import upgradeForQueuesPath from "~/assets/images/queues-dashboard.png";
import { AdminDebugTooltip } from "~/components/admin/debugTooltip";
import { QueuesHasNoTasks } from "~/components/BlankStatePanels";
import { environmentFullTitle } from "~/components/environments/EnvironmentLabel";
import { PageBody, PageContainer } from "~/components/layout/AppLayout";
import { Badge } from "~/components/primitives/Badge";
import { Button, LinkButton, type ButtonVariant } from "~/components/primitives/Buttons";
import { Callout } from "~/components/primitives/Callout";
import { Dialog, DialogContent, DialogHeader, DialogTrigger } from "~/components/primitives/Dialog";
import { FormButtons } from "~/components/primitives/FormButtons";
import { Header3 } from "~/components/primitives/Headers";
import { Input } from "~/components/primitives/Input";
import { NavBar, PageAccessories, PageTitle } from "~/components/primitives/PageHeader";
import { PaginationControls } from "~/components/primitives/Pagination";
import { Paragraph } from "~/components/primitives/Paragraph";
import { PopoverMenuItem } from "~/components/primitives/Popover";
import { SearchInput } from "~/components/primitives/SearchInput";
import { Spinner } from "~/components/primitives/Spinner";
import {
  Table,
  TableBody,
  TableCell,
  TableCellMenu,
  TableHeader,
  TableHeaderCell,
  TableRow,
} from "~/components/primitives/Table";
import {
  InfoIconTooltip,
  SimpleTooltip,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "~/components/primitives/Tooltip";
import { QueueName } from "~/components/runs/v3/QueueName";
import { env } from "~/env.server";
import { useAutoRevalidate } from "~/hooks/useAutoRevalidate";
import { useInterval } from "~/hooks/useInterval";
import { LoadingBarDivider } from "~/components/primitives/LoadingBarDivider";
import { useEnvironment } from "~/hooks/useEnvironment";
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
import { redirectWithErrorMessage, redirectWithSuccessMessage } from "~/models/message.server";
import { findProjectBySlug } from "~/models/project.server";
import { findEnvironmentBySlug } from "~/models/runtimeEnvironment.server";
import { getUserById } from "~/models/user.server";
import { EnvironmentQueuePresenter } from "~/presenters/v3/EnvironmentQueuePresenter.server";
import { QueueListPresenter } from "~/presenters/v3/QueueListPresenter.server";
import {
  QueueMetricsPresenter,
  isQueueMetricsWindow,
  type QueueMetricsWindow,
} from "~/presenters/v3/QueueMetricsPresenter.server";
import { UsageSparkline } from "~/components/primitives/UsageSparkline";
import { Area, AreaChart, ResponsiveContainer } from "recharts";
import { requireUserId } from "~/services/session.server";
import { cn } from "~/utils/cn";
import { ENVIRONMENT_PAUSE_SOURCE_BILLING_LIMIT } from "~/utils/environmentPauseSource";
import {
  concurrencyPath,
  docsPath,
  EnvironmentParamSchema,
  v3BillingPath,
  v3QueuePath,
  v3RunsPath,
} from "~/utils/pathBuilder";
import { concurrencySystem } from "~/v3/services/concurrencySystemInstance.server";
import { PauseEnvironmentService } from "~/v3/services/pauseEnvironment.server";
import { PauseQueueService } from "~/v3/services/pauseQueue.server";
import { useCurrentPlan } from "../_app.orgs.$organizationSlug/route";
import { BigNumber } from "~/components/metrics/BigNumber";
import { canAccessQueueMetricsUi } from "~/v3/canAccessQueueMetricsUi.server";

const SearchParamsSchema = z.object({
  query: z.string().optional(),
  page: z.coerce.number().min(1).default(1),
  period: z.string().optional(),
});

export const meta: MetaFunction = () => {
  return [
    {
      title: `Queues | Trigger.dev`,
    },
  ];
};

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const userId = await requireUserId(request);
  const { organizationSlug, projectParam, envParam } = EnvironmentParamSchema.parse(params);

  const url = new URL(request.url);
  const {
    page,
    query,
    period: rawPeriod,
  } = SearchParamsSchema.parse(Object.fromEntries(url.searchParams));
  const period: QueueMetricsWindow = isQueueMetricsWindow(rawPeriod) ? rawPeriod : "24h";

  const project = await findProjectBySlug(organizationSlug, projectParam, userId);
  if (!project) {
    throw new Response(undefined, {
      status: 404,
      statusText: "Project not found",
    });
  }

  const environment = await findEnvironmentBySlug(project.id, envParam, userId);
  if (!environment) {
    throw new Response(undefined, {
      status: 404,
      statusText: "Environment not found",
    });
  }

  // Per-org gate for the metrics UI. When off, this org gets the classic Queues page and
  // no metrics query fires.
  const queueMetricsUiEnabled = await canAccessQueueMetricsUi({ userId, organizationSlug });

  try {
    const queueListPresenter = new QueueListPresenter();
    const queues = await queueListPresenter.call({
      environment,
      query,
      page,
    });

    const environmentQueuePresenter = new EnvironmentQueuePresenter();

    const autoReloadPollIntervalMs = env.QUEUES_AUTORELOAD_POLL_INTERVAL_MS;

    // Per-queue list metrics (Delay p95 + backlog sparkline columns) are SSR'd with the table.
    // The environment header tiles are fetched client-side per card (see QueueEnvMetricTile) so a
    // slow ClickHouse query never blocks the queues list from rendering.
    let metrics: {
      window: QueueMetricsWindow;
      bucketStartMs: number;
      bucketIntervalMs: number;
      byQueue: Record<
        string,
        import("~/presenters/v3/QueueMetricsPresenter.server").QueueListMetric
      >;
    } | null = null;

    if (queueMetricsUiEnabled && queues.success) {
      const presenter = new QueueMetricsPresenter();
      const queueNames = queues.queues.map((q) => (q.type === "task" ? `task/${q.name}` : q.name));
      const queueMetrics =
        queueNames.length > 0
          ? await presenter.getQueueListMetrics({ environment, queueNames, window: period })
          : null;
      if (queueMetrics) {
        metrics = {
          window: queueMetrics.window,
          bucketStartMs: queueMetrics.bucketStartMs,
          bucketIntervalMs: queueMetrics.bucketIntervalMs,
          byQueue: Object.fromEntries(queueMetrics.byQueue),
        };
      }
    }

    return typedjson({
      ...queues,
      environment: await environmentQueuePresenter.call(environment),
      autoReloadPollIntervalMs,
      metrics,
      period,
      queueMetricsUiEnabled,
    });
  } catch (error) {
    console.error(error);
    throw new Response(undefined, {
      status: 400,
      statusText: "Something went wrong, if this problem persists please contact support.",
    });
  }
};

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const userId = await requireUserId(request);
  if (request.method.toLowerCase() !== "post") {
    return redirectWithErrorMessage(
      `/orgs/${params.organizationSlug}/projects/${params.projectParam}/env/${params.envParam}/queues`,
      request,
      "Wrong method"
    );
  }

  const { organizationSlug, projectParam, envParam } = EnvironmentParamSchema.parse(params);

  const project = await findProjectBySlug(organizationSlug, projectParam, userId);
  if (!project) {
    throw new Response(undefined, {
      status: 404,
      statusText: "Project not found",
    });
  }

  const environment = await findEnvironmentBySlug(project.id, envParam, userId);
  if (!environment) {
    throw new Response(undefined, {
      status: 404,
      statusText: "Environment not found",
    });
  }

  const formData = await request.formData();
  const action = formData.get("action");

  const url = new URL(request.url);
  const redirectPath = `/orgs/${organizationSlug}/projects/${projectParam}/env/${envParam}/queues${url.search}`;

  if (environment.archivedAt) {
    return redirectWithErrorMessage(redirectPath, request, "This branch is archived");
  }

  switch (action) {
    case "environment-pause": {
      const pauseService = new PauseEnvironmentService();
      const result = await pauseService.call(environment, "paused");
      if (!result.success) {
        return redirectWithErrorMessage(redirectPath, request, result.error);
      }
      return redirectWithSuccessMessage(redirectPath, request, "Environment paused");
    }
    case "environment-resume": {
      const resumeService = new PauseEnvironmentService();
      const result = await resumeService.call(environment, "resumed");
      if (!result.success) {
        return redirectWithErrorMessage(redirectPath, request, result.error);
      }
      return redirectWithSuccessMessage(redirectPath, request, "Environment resumed");
    }
    case "queue-pause":
    case "queue-resume": {
      const friendlyId = formData.get("friendlyId");
      if (!friendlyId) {
        return redirectWithErrorMessage(redirectPath, request, "Queue ID is required");
      }

      const queueService = new PauseQueueService();
      const result = await queueService.call(
        environment,
        friendlyId.toString(),
        action === "queue-pause" ? "paused" : "resumed"
      );

      if (!result.success) {
        return redirectWithErrorMessage(
          redirectPath,
          request,
          result.error ?? `Failed to ${action === "queue-pause" ? "pause" : "resume"} queue`
        );
      }

      return redirectWithSuccessMessage(
        redirectPath,
        request,
        `Queue ${action === "queue-pause" ? "paused" : "resumed"}`
      );
    }
    case "queue-override": {
      const friendlyId = formData.get("friendlyId");
      const concurrencyLimit = formData.get("concurrencyLimit");

      if (!friendlyId) {
        return redirectWithErrorMessage(redirectPath, request, "Queue ID is required");
      }

      if (!concurrencyLimit) {
        return redirectWithErrorMessage(redirectPath, request, "Concurrency limit is required");
      }

      const limitNumber = parseInt(concurrencyLimit.toString(), 10);
      if (isNaN(limitNumber) || limitNumber < 0) {
        return redirectWithErrorMessage(
          redirectPath,
          request,
          "Concurrency limit must be a valid number"
        );
      }

      const user = await getUserById(userId);
      if (!user) {
        return redirectWithErrorMessage(redirectPath, request, "User not found");
      }

      const result = await concurrencySystem.queues.overrideQueueConcurrencyLimit(
        environment,
        friendlyId.toString(),
        limitNumber,
        user
      );

      if (!result.isOk()) {
        return redirectWithErrorMessage(
          redirectPath,
          request,
          "Failed to override queue concurrency limit"
        );
      }

      return redirectWithSuccessMessage(
        redirectPath,
        request,
        "Queue concurrency limit overridden"
      );
    }
    case "queue-remove-override": {
      const friendlyId = formData.get("friendlyId");

      if (!friendlyId) {
        return redirectWithErrorMessage(redirectPath, request, "Queue ID is required");
      }

      const result = await concurrencySystem.queues.resetConcurrencyLimit(
        environment,
        friendlyId.toString()
      );

      if (!result.isOk()) {
        return redirectWithErrorMessage(
          redirectPath,
          request,
          "Failed to reset queue concurrency limit"
        );
      }

      return redirectWithSuccessMessage(redirectPath, request, "Queue concurrency limit reset");
    }
    default:
      return redirectWithErrorMessage(redirectPath, request, "Something went wrong");
  }
};

export default function Page() {
  // Per-org flag decides which whole page renders. Off => the classic Queues page,
  // byte-for-byte the pre-metrics UI. Each branch is its own component (own hooks).
  const { queueMetricsUiEnabled } = useTypedLoaderData<typeof loader>();
  return queueMetricsUiEnabled ? <QueuesWithMetricsView /> : <ClassicQueuesView />;
}

function QueuesWithMetricsView() {
  const {
    environment,
    queues,
    success,
    pagination,
    code,
    totalQueues,
    hasFilters,
    autoReloadPollIntervalMs,
    metrics,
    period,
  } = useTypedLoaderData<typeof loader>();

  const metricsByQueue = metrics?.byQueue ?? {};

  const organization = useOrganization();
  const project = useProject();
  const env = useEnvironment();
  const plan = useCurrentPlan();

  useAutoRevalidate({ interval: autoReloadPollIntervalMs, onFocus: true });

  return (
    <PageContainer>
      <NavBar>
        <PageTitle title="Queues" />
        <PageAccessories>
          <AdminDebugTooltip />
          {plan ? (
            plan?.v3Subscription?.plan?.limits.concurrentRuns.canExceed ? (
              <LinkButton
                to={concurrencyPath(organization, project, env)}
                variant="tertiary/small"
                LeadingIcon={ConcurrencyIcon}
                leadingIconClassName="text-amber-500"
              >
                Increase limit
              </LinkButton>
            ) : (
              <LinkButton
                to={v3BillingPath(organization, "Upgrade your plan for more concurrency")}
                variant="tertiary/small"
                LeadingIcon={ArrowUpCircleIcon}
                leadingIconClassName="text-indigo-500"
              >
                Increase limit
              </LinkButton>
            )
          ) : null}
          {environment.runsEnabled && env.pauseSource !== ENVIRONMENT_PAUSE_SOURCE_BILLING_LIMIT ? (
            <EnvironmentPauseResumeButton env={env} />
          ) : null}
          <LinkButton
            variant={"docs/small"}
            LeadingIcon={BookOpenIcon}
            to={docsPath("/queue-concurrency")}
          >
            Queues docs
          </LinkButton>
        </PageAccessories>
      </NavBar>
      <PageBody scrollable={false}>
        <div className="grid max-h-full grid-rows-[auto_1fr] overflow-hidden">
          <div className="grid grid-cols-2 gap-3 p-3 lg:grid-cols-4">
            {QUEUE_HEADER_TILES.map((tile) => (
              <QueueEnvMetricTile key={tile.id} tile={tile} period={period} />
            ))}
          </div>

          {success ? (
            <div className="grid max-h-full min-h-full grid-rows-[auto_1fr] overflow-x-auto">
              <div className="flex items-center justify-between gap-2 border-t border-grid-dimmed px-1.5 py-1.5">
                <div className="flex items-center gap-3">
                  <QueueFilters />
                  <QueuePeriodSelect period={period} />
                </div>
                <PaginationControls
                  currentPage={pagination.currentPage}
                  totalPages={pagination.mode === "unfiltered" ? pagination.totalPages : 1}
                  hasNextPage={pagination.mode === "filtered" ? pagination.hasMore : undefined}
                  showPageNumbers={false}
                />
              </div>
              <Table containerClassName="border-t">
                <TableHeader>
                  <TableRow>
                    <TableHeaderCell>Name</TableHeaderCell>
                    <TableHeaderCell alignment="right">Queued</TableHeaderCell>
                    <TableHeaderCell alignment="right">Running</TableHeaderCell>
                    <TableHeaderCell alignment="right">Limit</TableHeaderCell>
                    <TableHeaderCell
                      alignment="right"
                      tooltip={
                        <div className="max-w-xs space-y-2 p-1 text-left">
                          <div className="space-y-0.5">
                            <Header3>Environment</Header3>
                            <Paragraph
                              variant="small"
                              className="!text-wrap text-text-dimmed"
                              spacing
                            >
                              This queue is limited by your environment's concurrency limit of{" "}
                              {environment.concurrencyLimit}.
                            </Paragraph>
                          </div>
                          <div className="space-y-0.5">
                            <Header3>User</Header3>
                            <Paragraph
                              variant="small"
                              className="!text-wrap text-text-dimmed"
                              spacing
                            >
                              This queue is limited by a concurrency limit set in your code.
                            </Paragraph>
                          </div>
                          <div className="space-y-0.5">
                            <Header3>Override</Header3>
                            <Paragraph
                              variant="small"
                              className="!text-wrap text-text-dimmed"
                              spacing
                            >
                              This queue's concurrency limit has been manually overridden from the
                              dashboard or API.
                            </Paragraph>
                          </div>
                        </div>
                      }
                    >
                      Limited by
                    </TableHeaderCell>
                    <TableHeaderCell>Health</TableHeaderCell>
                    <TableHeaderCell
                      alignment="right"
                      tooltip="The 95th-percentile scheduling delay (time from when a run became eligible to when it was dequeued) over the selected window."
                    >
                      Delay p95
                    </TableHeaderCell>
                    <TableHeaderCell>Backlog</TableHeaderCell>
                    <TableHeaderCell className="w-[1%] pl-32">
                      <span className="sr-only">Pause/resume</span>
                    </TableHeaderCell>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {queues.length > 0 ? (
                    queues.map((queue) => {
                      const limit = queue.concurrencyLimit ?? environment.concurrencyLimit;
                      const isAtConcurrencyLimit = queue.running >= limit;
                      const isAtQueueLimit =
                        environment.queueSizeLimit !== null &&
                        queue.queued >= environment.queueSizeLimit;
                      const queueFilterableName = `${queue.type === "task" ? "task/" : ""}${
                        queue.name
                      }`;
                      const queueMetric = metricsByQueue[queueFilterableName];
                      return (
                        <TableRow key={queue.name}>
                          <TableCell>
                            <span className="flex items-center gap-2">
                              <Link
                                to={v3QueuePath(organization, project, env, {
                                  friendlyId: queue.id,
                                })}
                                className="rounded-sm hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-charcoal-500"
                              >
                                <QueueName {...queue} />
                              </Link>
                              {queue.concurrency?.overriddenAt ? (
                                <SimpleTooltip
                                  button={
                                    <Badge variant="extra-small" className="text-text-bright">
                                      Concurrency limit overridden
                                    </Badge>
                                  }
                                  content="This queue's concurrency limit has been manually overridden from the dashboard or API."
                                  className="max-w-xs"
                                  disableHoverableContent
                                />
                              ) : null}
                              {queue.paused ? (
                                <Badge variant="extra-small" className="text-warning">
                                  Paused
                                </Badge>
                              ) : null}
                              {isAtQueueLimit ? (
                                <Badge variant="extra-small" className="text-error">
                                  At queue limit
                                </Badge>
                              ) : null}
                              {isAtConcurrencyLimit ? (
                                <Badge variant="extra-small" className="text-warning">
                                  At concurrency limit
                                </Badge>
                              ) : null}
                            </span>
                          </TableCell>
                          <TableCell
                            alignment="right"
                            className={cn(
                              "w-[1%] pl-16 tabular-nums",
                              queue.paused ? "opacity-50" : undefined,
                              isAtQueueLimit && "text-error"
                            )}
                          >
                            {queue.queued}
                          </TableCell>
                          <TableCell
                            alignment="right"
                            className={cn(
                              "w-[1%] pl-16 tabular-nums",
                              queue.paused ? "opacity-50" : undefined,
                              queue.running > 0 && "text-text-bright",
                              isAtConcurrencyLimit && "text-warning"
                            )}
                          >
                            {queue.running}
                          </TableCell>
                          <TableCell
                            alignment="right"
                            className={cn(
                              "w-[1%] pl-16 tabular-nums",
                              queue.paused ? "opacity-50" : undefined,
                              queue.concurrency?.overriddenAt && "font-medium text-text-bright"
                            )}
                          >
                            {limit}
                          </TableCell>
                          <TableCell
                            alignment="right"
                            className={cn(
                              "w-[1%] pl-16",
                              queue.paused ? "opacity-50" : undefined,
                              isAtConcurrencyLimit && "text-warning",
                              queue.concurrency?.overriddenAt && "font-medium text-text-bright"
                            )}
                          >
                            {queue.concurrency?.overriddenAt ? (
                              <span className="text-text-bright">Override</span>
                            ) : queue.concurrencyLimit ? (
                              "User"
                            ) : (
                              "Environment"
                            )}
                          </TableCell>
                          <TableCell className={cn(queue.paused ? "opacity-50" : undefined)}>
                            <QueueHealthBadge
                              paused={queue.paused}
                              running={queue.running}
                              queued={queue.queued}
                              limit={limit}
                            />
                          </TableCell>
                          <TableCell alignment="right" className="tabular-nums">
                            {queueMetric && queueMetric.p95WaitMs !== null ? (
                              <span
                                className={cn(
                                  queueMetric.p95WaitMs >= 60_000
                                    ? "text-warning"
                                    : "text-text-bright"
                                )}
                              >
                                {formatWaitMs(queueMetric.p95WaitMs)}
                              </span>
                            ) : (
                              <span className="text-text-dimmed">–</span>
                            )}
                          </TableCell>
                          <TableCell>
                            <UsageSparkline
                              data={queueMetric?.depthSparkline}
                              total={queueMetric?.peakQueued}
                              bucketStartMs={metrics?.bucketStartMs}
                              bucketIntervalMs={metrics?.bucketIntervalMs}
                              color="#A78BFA"
                              totalClassName="text-text-dimmed"
                              unitLabel={{ singular: "queued", plural: "queued" }}
                              formatTotal={(v) => v.toLocaleString()}
                            />
                          </TableCell>
                          <TableCellMenu
                            isSticky
                            visibleButtons={
                              queue.paused && <QueuePauseResumeButton queue={queue} />
                            }
                            hiddenButtons={
                              !queue.paused && <QueuePauseResumeButton queue={queue} />
                            }
                            popoverContent={
                              <>
                                {queue.paused ? (
                                  <QueuePauseResumeButton
                                    queue={queue}
                                    variant="minimal/small"
                                    fullWidth
                                    showTooltip={false}
                                  />
                                ) : (
                                  <QueuePauseResumeButton
                                    queue={queue}
                                    variant="minimal/small"
                                    fullWidth
                                    showTooltip={false}
                                  />
                                )}

                                <PopoverMenuItem
                                  icon={RunsIcon}
                                  leadingIconClassName="text-runs"
                                  title="View all runs"
                                  to={v3RunsPath(organization, project, env, {
                                    queues: [queueFilterableName],
                                    period: "30d",
                                    rootOnly: false,
                                  })}
                                />
                                <PopoverMenuItem
                                  icon={RectangleStackIcon}
                                  leadingIconClassName="text-queues"
                                  title="View queued runs"
                                  to={v3RunsPath(organization, project, env, {
                                    queues: [queueFilterableName],
                                    statuses: ["PENDING"],
                                    period: "30d",
                                    rootOnly: false,
                                  })}
                                />
                                <PopoverMenuItem
                                  icon={Spinner}
                                  leadingIconClassName="text-queues animate-none"
                                  title="View running runs"
                                  to={v3RunsPath(organization, project, env, {
                                    queues: [queueFilterableName],
                                    statuses: ["DEQUEUED", "EXECUTING"],
                                    period: "30d",
                                    rootOnly: false,
                                  })}
                                />
                                <QueueOverrideConcurrencyButton
                                  queue={queue}
                                  environmentConcurrencyLimit={environment.concurrencyLimit}
                                />
                              </>
                            }
                          />
                        </TableRow>
                      );
                    })
                  ) : (
                    <TableRow>
                      <TableCell colSpan={9}>
                        <div className="grid place-items-center py-6 text-text-dimmed">
                          <Paragraph>
                            {hasFilters
                              ? "No queues found matching your filters"
                              : "No queues found"}
                          </Paragraph>
                        </div>
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </div>
          ) : (
            <div className="grid place-items-center py-6 text-text-dimmed">
              {totalQueues === 0 ? (
                <div className="pt-12">
                  <QueuesHasNoTasks />
                </div>
              ) : code === "engine-version" ? (
                <EngineVersionUpgradeCallout />
              ) : (
                <Callout variant="error">Something went wrong</Callout>
              )}
            </div>
          )}
        </div>
      </PageBody>
    </PageContainer>
  );
}

function EnvironmentPauseResumeButton({
  env,
}: {
  env: { type: RuntimeEnvironmentType; paused: boolean };
}) {
  const navigation = useNavigation();
  const [isOpen, setIsOpen] = useState(false);

  useEffect(() => {
    if (navigation.state === "loading" || navigation.state === "idle") {
      setIsOpen(false);
    }
  }, [navigation.state]);

  const isLoading = Boolean(
    navigation.formData?.get("action") === (env.paused ? "environment-resume" : "environment-pause")
  );

  return (
    <Dialog open={isOpen} onOpenChange={setIsOpen}>
      <div>
        <TooltipProvider disableHoverableContent={true}>
          <Tooltip>
            <TooltipTrigger asChild>
              <div>
                <DialogTrigger asChild>
                  <Button
                    type="button"
                    variant="secondary/small"
                    LeadingIcon={env.paused ? PlayIcon : PauseIcon}
                    leadingIconClassName={env.paused ? "text-success" : "text-warning"}
                  >
                    {env.paused ? "Resume..." : "Pause environment..."}
                  </Button>
                </DialogTrigger>
              </div>
            </TooltipTrigger>
            <TooltipContent className={"text-xs"}>
              {env.paused
                ? `Resume processing runs in ${environmentFullTitle(env)}`
                : `Pause processing runs in ${environmentFullTitle(env)}`}
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      </div>
      <DialogContent>
        <DialogHeader>{env.paused ? "Resume environment?" : "Pause environment?"}</DialogHeader>
        <div className="flex flex-col gap-3 pt-3">
          <Paragraph>
            {env.paused
              ? `This will allow runs to be dequeued in ${environmentFullTitle(env)} again.`
              : `This will pause all runs from being dequeued in ${environmentFullTitle(
                  env
                )}. Any executing runs will continue to run.`}
          </Paragraph>
          <Form method="post" onSubmit={() => setIsOpen(false)}>
            <input
              type="hidden"
              name="action"
              value={env.paused ? "environment-resume" : "environment-pause"}
            />
            <FormButtons
              confirmButton={
                <Button
                  type="submit"
                  disabled={isLoading}
                  variant={env.paused ? "primary/medium" : "danger/medium"}
                  LeadingIcon={
                    isLoading ? <Spinner color="white" /> : env.paused ? PlayIcon : PauseIcon
                  }
                  shortcut={{ modifiers: ["mod"], key: "enter" }}
                >
                  {env.paused ? "Resume environment" : "Pause environment"}
                </Button>
              }
              cancelButton={
                <DialogClose asChild>
                  <Button type="button" variant="tertiary/medium">
                    Cancel
                  </Button>
                </DialogClose>
              }
            />
          </Form>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function QueuePauseResumeButton({
  queue,
  variant = "tertiary/small",
  fullWidth = false,
  showTooltip = true,
}: {
  /** The "id" here is a friendlyId */
  queue: { id: string; name: string; paused: boolean };
  variant?: ButtonVariant;
  fullWidth?: boolean;
  showTooltip?: boolean;
}) {
  const [isOpen, setIsOpen] = useState(false);

  const trigger = showTooltip ? (
    <div>
      <TooltipProvider disableHoverableContent={true}>
        <Tooltip>
          <TooltipTrigger asChild>
            <div>
              <DialogTrigger asChild>
                <Button
                  type="button"
                  variant={variant}
                  LeadingIcon={queue.paused ? PlayIcon : PauseIcon}
                  leadingIconClassName={queue.paused ? "text-success" : "text-warning"}
                  fullWidth={fullWidth}
                  textAlignLeft={fullWidth}
                >
                  {queue.paused ? "Resume..." : "Pause..."}
                </Button>
              </DialogTrigger>
            </div>
          </TooltipTrigger>
          <TooltipContent side="right" className={"text-xs"}>
            {queue.paused
              ? `Resume processing runs in queue "${queue.name}"`
              : `Pause processing runs in queue "${queue.name}"`}
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    </div>
  ) : (
    <DialogTrigger asChild>
      <PopoverMenuItem
        icon={queue.paused ? PlayIcon : PauseIcon}
        leadingIconClassName={queue.paused ? "text-success" : "text-warning"}
        title={queue.paused ? "Resume..." : "Pause..."}
      />
    </DialogTrigger>
  );

  return (
    <Dialog open={isOpen} onOpenChange={setIsOpen}>
      {trigger}
      <DialogContent>
        <DialogHeader>{queue.paused ? "Resume queue?" : "Pause queue?"}</DialogHeader>
        <div className="flex flex-col gap-3 pt-3">
          <Paragraph>
            {queue.paused
              ? `This will allow runs to be dequeued in the "${queue.name}" queue again.`
              : `This will pause all runs from being dequeued in the "${queue.name}" queue. Any executing runs will continue to run.`}
          </Paragraph>
          <Form method="post" onSubmit={() => setIsOpen(false)}>
            <input
              type="hidden"
              name="action"
              value={queue.paused ? "queue-resume" : "queue-pause"}
            />
            <input type="hidden" name="friendlyId" value={queue.id} />
            <FormButtons
              confirmButton={
                <Button
                  type="submit"
                  shortcut={{ modifiers: ["mod"], key: "enter" }}
                  variant={queue.paused ? "primary/medium" : "danger/medium"}
                  LeadingIcon={queue.paused ? PlayIcon : PauseIcon}
                >
                  {queue.paused ? "Resume queue" : "Pause queue"}
                </Button>
              }
              cancelButton={
                <DialogClose asChild>
                  <Button type="button" variant="tertiary/medium">
                    Cancel
                  </Button>
                </DialogClose>
              }
            />
          </Form>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function QueueOverrideConcurrencyButton({
  queue,
  environmentConcurrencyLimit,
}: {
  queue: QueueItem;
  environmentConcurrencyLimit: number;
}) {
  const navigation = useNavigation();
  const [isOpen, setIsOpen] = useState(false);
  const [concurrencyLimit, setConcurrencyLimit] = useState<string>(
    queue.concurrencyLimit?.toString() ?? environmentConcurrencyLimit.toString()
  );

  const isOverridden = !!queue.concurrency?.overriddenAt;
  const currentLimit = queue.concurrencyLimit ?? environmentConcurrencyLimit;

  useEffect(() => {
    if (navigation.state === "loading" || navigation.state === "idle") {
      setIsOpen(false);
    }
  }, [navigation.state]);

  const isLoading = Boolean(
    navigation.formData?.get("action") === "queue-override" ||
    navigation.formData?.get("action") === "queue-remove-override"
  );

  return (
    <Dialog open={isOpen} onOpenChange={setIsOpen}>
      <DialogTrigger asChild>
        <PopoverMenuItem
          icon={AdjustmentsHorizontalIcon}
          title={isOverridden ? "Edit override…" : "Override limit…"}
        />
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          {isOverridden ? "Edit concurrency override" : "Override concurrency limit"}
        </DialogHeader>
        <div className="flex flex-col gap-3 pt-3">
          {isOverridden ? (
            <Paragraph>
              This queue's concurrency limit is currently overridden to {currentLimit}.
              {typeof queue.concurrency?.base === "number" &&
                ` The original limit set in code was ${queue.concurrency.base}.`}{" "}
              You can update the override or remove it to restore the{" "}
              {typeof queue.concurrency?.base === "number"
                ? "limit set in code"
                : "environment concurrency limit"}
              .
            </Paragraph>
          ) : (
            <Paragraph>
              Override this queue's concurrency limit. The current limit is {currentLimit}, which is
              set {queue.concurrencyLimit !== null ? "in code" : "by the environment"}.
            </Paragraph>
          )}
          <Form method="post" onSubmit={() => setIsOpen(false)} className="space-y-3">
            <input type="hidden" name="friendlyId" value={queue.id} />
            <div className="space-y-2">
              <label htmlFor="concurrencyLimit" className="text-sm text-text-bright">
                Concurrency limit
              </label>
              <Input
                type="number"
                name="concurrencyLimit"
                id="concurrencyLimit"
                min="0"
                max={environmentConcurrencyLimit}
                value={concurrencyLimit}
                onChange={(e) => setConcurrencyLimit(e.target.value)}
                placeholder={currentLimit.toString()}
                autoFocus
              />
            </div>

            <FormButtons
              defaultAction={{
                name: "action",
                value: "queue-override",
                disabled: isLoading || !concurrencyLimit,
              }}
              confirmButton={
                <Button
                  type="submit"
                  name="action"
                  value="queue-override"
                  disabled={isLoading || !concurrencyLimit}
                  variant="primary/medium"
                  LeadingIcon={isLoading && <Spinner color="white" />}
                  shortcut={{ modifiers: ["mod"], key: "enter" }}
                >
                  {isOverridden ? "Update override" : "Override limit"}
                </Button>
              }
              cancelButton={
                <div className="flex items-center justify-between gap-2">
                  {isOverridden && (
                    <Button
                      type="submit"
                      name="action"
                      value="queue-remove-override"
                      disabled={isLoading}
                      variant="danger/medium"
                    >
                      Remove override
                    </Button>
                  )}
                  <DialogClose asChild>
                    <Button type="button" variant="tertiary/medium">
                      Cancel
                    </Button>
                  </DialogClose>
                </div>
              }
            />
          </Form>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function EngineVersionUpgradeCallout() {
  return (
    <div className="mt-4 flex max-w-lg flex-col gap-4 rounded-sm border border-grid-bright bg-background-bright px-4">
      <div className="flex items-center justify-between gap-2 border-b border-grid-dimmed py-4">
        <h4 className="text-base text-text-bright">New queues table</h4>
        <LinkButton
          LeadingIcon={BookOpenIcon}
          to={docsPath("upgrade-to-v4")}
          variant={"docs/small"}
        >
          Upgrade guide
        </LinkButton>
      </div>
      <div className="space-y-4 pb-4">
        <Paragraph variant="small">
          Upgrade to SDK version 4+ to view the new queues table, and be able to pause and resume
          individual queues.
        </Paragraph>
        <img
          src={upgradeForQueuesPath}
          alt="Upgrade for queues"
          className="rounded-sm border border-grid-dimmed"
        />
      </div>
    </div>
  );
}

export function isEnvironmentPauseResumeFormSubmission(
  formMethod: string | undefined,
  formData: FormData | undefined
) {
  if (!formMethod || !formData) {
    return false;
  }

  return (
    formMethod.toLowerCase() === "post" &&
    (formData.get("action") === "environment-pause" ||
      formData.get("action") === "environment-resume")
  );
}

export function QueueFilters() {
  return <SearchInput placeholder="Search queues…" paramName="query" resetParams={["page"]} />;
}

const QUEUE_METRICS_PERIODS: { value: QueueMetricsWindow; label: string }[] = [
  { value: "1h", label: "1h" },
  { value: "6h", label: "6h" },
  { value: "24h", label: "24h" },
];

function QueuePeriodSelect({ period }: { period: QueueMetricsWindow }) {
  const [searchParams] = useSearchParams();
  const hrefFor = (value: QueueMetricsWindow) => {
    const next = new URLSearchParams(searchParams);
    next.set("period", value);
    next.delete("page");
    return `?${next.toString()}`;
  };
  return (
    <div className="flex items-center gap-1">
      <span className="text-xs text-text-dimmed">Metrics</span>
      {QUEUE_METRICS_PERIODS.map(({ value, label }) => (
        <LinkButton
          key={value}
          to={hrefFor(value)}
          variant={value === period ? "secondary/small" : "minimal/small"}
          className={value === period ? "text-text-bright" : "text-text-dimmed"}
        >
          {label}
        </LinkButton>
      ))}
    </div>
  );
}

type MetricTileRow = Record<string, number | string | null>;

type MetricTileResponse =
  | { success: true; data: { rows: MetricTileRow[] } }
  | { success: false; error: string };

type QueueHeaderTile = {
  id: string;
  label: string;
  color: string;
  query: string;
  derive: (rows: MetricTileRow[]) => {
    sparkline: number[];
    value: ReactNode;
    valueClassName?: string;
  };
};

function tileNumber(value: number | string | null): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}

// Header tiles fetch their own TRQL query client-side (resources.metric) with fillGaps, mirroring the
// metrics dashboard widgets: the gauges (saturation inputs, backlog) carry, counters/p95 zero-fill.
const QUEUE_HEADER_TILES: QueueHeaderTile[] = [
  {
    id: "saturation",
    label: "Env saturation",
    color: "#6366F1",
    query: `SELECT timeBucket() AS t,\n  max(max_env_running) AS used,\n  max(max_env_limit) AS env_limit\nFROM queue_metrics\nGROUP BY t\nORDER BY t`,
    derive: (rows) => {
      const sparkline = rows.map((r) => {
        const limit = tileNumber(r.env_limit);
        return limit > 0 ? Math.round((tileNumber(r.used) / limit) * 100) : 0;
      });
      const peak = sparkline.reduce((max, v) => Math.max(max, v), 0);
      return { sparkline, value: `${peak}% peak` };
    },
  },
  {
    id: "backlog",
    label: "Backlog",
    color: "#A78BFA",
    query: `SELECT timeBucket() AS t,\n  max(max_env_queued) AS queued\nFROM queue_metrics\nGROUP BY t\nORDER BY t`,
    derive: (rows) => {
      const sparkline = rows.map((r) => tileNumber(r.queued));
      const peak = sparkline.reduce((max, v) => Math.max(max, v), 0);
      return { sparkline, value: `${peak.toLocaleString()} peak` };
    },
  },
  {
    id: "p95",
    label: "Scheduling delay p95",
    color: "#F59E0B",
    query: `SELECT timeBucket() AS t,\n  round(quantilesMerge(0.5, 0.95, 0.99)(wait_quantiles)[2]) AS p95\nFROM queue_metrics\nGROUP BY t\nORDER BY t`,
    derive: (rows) => {
      const sparkline = rows.map((r) => tileNumber(r.p95));
      const worst = sparkline.reduce((max, v) => Math.max(max, v), 0);
      return {
        sparkline,
        value: worst > 0 ? formatWaitMs(worst) : "–",
        valueClassName: worst >= 60_000 ? "text-warning" : undefined,
      };
    },
  },
  {
    id: "throttled",
    label: "Throttled",
    color: "#F59E0B",
    query: `SELECT timeBucket() AS t,\n  sum(throttled_count) AS throttled\nFROM queue_metrics\nGROUP BY t\nORDER BY t`,
    derive: (rows) => {
      const sparkline = rows.map((r) => tileNumber(r.throttled));
      const total = sparkline.reduce((sum, v) => sum + v, 0);
      return {
        sparkline,
        value: total.toLocaleString(),
        valueClassName: total > 0 ? "text-warning" : undefined,
      };
    },
  },
];

function QueueEnvMetricTile({
  tile,
  period,
}: {
  tile: QueueHeaderTile;
  period: QueueMetricsWindow;
}) {
  const organization = useOrganization();
  const project = useProject();
  const environment = useEnvironment();
  const [response, setResponse] = useState<MetricTileResponse | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const abortRef = useRef<AbortController | null>(null);

  const orgId = organization.id;
  const projectId = project.id;
  const environmentId = environment.id;
  const { query } = tile;

  const load = useCallback(() => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setIsLoading(true);
    fetch("/resources/metric", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query,
        scope: "environment",
        period,
        from: null,
        to: null,
        fillGaps: true,
        organizationId: orgId,
        projectId,
        environmentId,
      }),
      signal: controller.signal,
    })
      .then((res) => res.json() as Promise<MetricTileResponse>)
      .then((data) => {
        if (!controller.signal.aborted) {
          setResponse(data);
          setIsLoading(false);
        }
      })
      .catch((error) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
        if (!controller.signal.aborted) {
          setResponse({ success: false, error: "Network error" });
          setIsLoading(false);
        }
      });
  }, [query, period, orgId, projectId, environmentId]);

  useEffect(() => {
    load();
    return () => abortRef.current?.abort();
  }, [load]);

  useInterval({ interval: 60_000, onLoad: false, onFocus: true, callback: load });

  const rows = response?.success ? response.data.rows : [];
  const hasData = rows.length > 0;
  const showLoading = isLoading && !hasData;
  const failed = response !== null && !response.success;
  const { sparkline, value, valueClassName } = tile.derive(rows);

  return (
    <HeaderTile
      label={`${tile.label} · ${period}`}
      value={
        showLoading ? (
          <span className="inline-block h-3 w-12 animate-pulse rounded bg-grid-bright" />
        ) : failed ? undefined : (
          value
        )
      }
      valueClassName={valueClassName}
    >
      <LoadingBarDivider isLoading={isLoading} className="bg-transparent" />
      {showLoading ? (
        <div className="h-12 w-full animate-pulse rounded bg-grid-bright/60" />
      ) : failed ? (
        <div className="flex h-12 items-center text-xs text-text-dimmed">
          Unable to load metrics
        </div>
      ) : (
        <MiniChart data={sparkline} color={tile.color} />
      )}
    </HeaderTile>
  );
}

function HeaderTile({
  label,
  value,
  valueClassName,
  className,
  children,
}: {
  label: ReactNode;
  value?: ReactNode;
  valueClassName?: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div
      className={cn(
        "flex flex-col gap-1.5 rounded-md border border-grid-dimmed bg-background-dimmed px-3 py-2",
        className
      )}
    >
      <div className="flex items-baseline justify-between gap-2">
        <span className="truncate text-xs text-text-dimmed">{label}</span>
        {value !== undefined ? (
          <span className={cn("shrink-0 text-sm tabular-nums text-text-bright", valueClassName)}>
            {value}
          </span>
        ) : null}
      </div>
      {children}
    </div>
  );
}

function MiniChart({ data, color }: { data: number[]; color: string }) {
  if (!data || data.length === 0 || data.every((v) => v === 0)) {
    return <div className="flex h-12 items-center text-xs text-text-dimmed">No activity</div>;
  }
  const chartData = data.map((v, i) => ({ i, v }));
  return (
    <div className="h-12 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={chartData} margin={{ top: 2, right: 0, left: 0, bottom: 0 }}>
          <Area
            type="monotone"
            dataKey="v"
            stroke={color}
            fill={color}
            fillOpacity={0.15}
            strokeWidth={1.5}
            isAnimationActive={false}
            dot={false}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

function QueueHealthBadge({
  paused,
  running,
  queued,
  limit,
}: {
  paused: boolean;
  running: number;
  queued: number;
  limit: number;
}) {
  if (paused) {
    return (
      <Badge variant="extra-small" className="text-warning">
        Paused
      </Badge>
    );
  }
  if (running >= limit && queued > 0) {
    return (
      <Badge variant="extra-small" className="text-warning">
        At capacity
      </Badge>
    );
  }
  if (queued > 0) {
    return (
      <Badge variant="extra-small" className="text-blue-400">
        Backlogged
      </Badge>
    );
  }
  if (running > 0) {
    return (
      <Badge variant="extra-small" className="text-success">
        Active
      </Badge>
    );
  }
  return (
    <Badge variant="extra-small" className="text-text-dimmed">
      Idle
    </Badge>
  );
}

function formatWaitMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 3_600_000) return `${(ms / 60_000).toFixed(1)}m`;
  return `${(ms / 3_600_000).toFixed(1)}h`;
}

// Classic Queues page, restored verbatim from before the Queue Metrics feature. Rendered
// when queueMetricsUiEnabled is off so a gated org sees exactly the pre-metrics UI.
function ClassicQueuesView() {
  const {
    environment,
    queues,
    success,
    pagination,
    code,
    totalQueues,
    hasFilters,
    autoReloadPollIntervalMs,
  } = useTypedLoaderData<typeof loader>();

  const organization = useOrganization();
  const project = useProject();
  const env = useEnvironment();
  const plan = useCurrentPlan();

  useAutoRevalidate({ interval: autoReloadPollIntervalMs, onFocus: true });

  const limitStatus =
    environment.running === environment.concurrencyLimit * environment.burstFactor
      ? "limit"
      : environment.running > environment.concurrencyLimit
        ? "burst"
        : "within";

  const limitClassName =
    limitStatus === "burst" ? "text-warning" : limitStatus === "limit" ? "text-error" : undefined;

  return (
    <PageContainer>
      <NavBar>
        <PageTitle title="Queues" />
        <PageAccessories>
          <AdminDebugTooltip />
          <LinkButton
            variant={"docs/small"}
            LeadingIcon={BookOpenIcon}
            to={docsPath("/queue-concurrency")}
          >
            Queues docs
          </LinkButton>
        </PageAccessories>
      </NavBar>
      <PageBody scrollable={false}>
        <div className="grid max-h-full grid-rows-[auto_1fr] overflow-hidden">
          <div className="grid grid-cols-3 gap-3 p-3">
            <BigNumber
              title="Queued"
              value={environment.queued}
              suffix={env.paused ? <span className="text-warning">paused</span> : undefined}
              animate
              accessory={
                <div className="flex items-start gap-1">
                  {environment.runsEnabled &&
                  env.pauseSource !== ENVIRONMENT_PAUSE_SOURCE_BILLING_LIMIT ? (
                    <EnvironmentPauseResumeButton env={env} />
                  ) : null}
                  <LinkButton
                    variant="secondary/small"
                    LeadingIcon={RunsIcon}
                    leadingIconClassName="text-runs"
                    className="px-2"
                    to={v3RunsPath(organization, project, env, {
                      statuses: ["PENDING"],
                      period: "30d",
                      rootOnly: false,
                    })}
                    tooltip="View queued runs"
                  />
                </div>
              }
              valueClassName={env.paused ? "text-warning tabular-nums" : "tabular-nums"}
              compactThreshold={1000000}
            />
            <BigNumber
              title="Running"
              value={environment.running}
              animate
              valueClassName={cn(limitClassName, "tabular-nums")}
              suffix={
                limitStatus === "burst" ? (
                  <span className={cn(limitClassName, "flex items-center gap-1")}>
                    Including {environment.running - environment.concurrencyLimit} burst runs{" "}
                    <BurstFactorTooltip environment={environment} />
                  </span>
                ) : limitStatus === "limit" ? (
                  "At concurrency limit"
                ) : undefined
              }
              accessory={
                <LinkButton
                  variant="secondary/small"
                  LeadingIcon={RunsIcon}
                  leadingIconClassName="text-runs"
                  className="px-2"
                  to={v3RunsPath(organization, project, env, {
                    statuses: ["DEQUEUED", "EXECUTING"],
                    period: "30d",
                    rootOnly: false,
                  })}
                  tooltip="View running runs"
                />
              }
              compactThreshold={1000000}
            />
            <BigNumber
              title="Concurrency limit"
              value={environment.concurrencyLimit}
              animate
              valueClassName={limitClassName}
              suffix={
                environment.burstFactor > 1 ? (
                  <span className={cn(limitClassName, "flex items-center gap-1")}>
                    Burst limit {environment.burstFactor * environment.concurrencyLimit}{" "}
                    <BurstFactorTooltip environment={environment} />
                  </span>
                ) : undefined
              }
              accessory={
                plan ? (
                  plan?.v3Subscription?.plan?.limits.concurrentRuns.canExceed ? (
                    <LinkButton
                      to={concurrencyPath(organization, project, env)}
                      variant="tertiary/small"
                      LeadingIcon={ConcurrencyIcon}
                      leadingIconClassName="text-amber-500"
                    >
                      Increase limit
                    </LinkButton>
                  ) : (
                    <LinkButton
                      to={v3BillingPath(organization, "Upgrade your plan for more concurrency")}
                      variant="secondary/small"
                      LeadingIcon={ArrowUpCircleIcon}
                      leadingIconClassName="text-indigo-500"
                    >
                      Increase limit
                    </LinkButton>
                  )
                ) : null
              }
            />
          </div>

          {success ? (
            <div className="grid max-h-full min-h-full grid-rows-[auto_1fr] overflow-x-auto">
              <div className="flex items-center justify-between gap-2 border-t border-grid-dimmed px-1.5 py-1.5">
                <QueueFilters />
                <PaginationControls
                  currentPage={pagination.currentPage}
                  totalPages={pagination.mode === "unfiltered" ? pagination.totalPages : 1}
                  hasNextPage={pagination.mode === "filtered" ? pagination.hasMore : undefined}
                  showPageNumbers={false}
                />
              </div>
              <Table containerClassName="border-t">
                <TableHeader>
                  <TableRow>
                    <TableHeaderCell>Name</TableHeaderCell>
                    <TableHeaderCell alignment="right">Queued</TableHeaderCell>
                    <TableHeaderCell alignment="right">Running</TableHeaderCell>
                    <TableHeaderCell alignment="right">Limit</TableHeaderCell>
                    <TableHeaderCell
                      alignment="right"
                      tooltip={
                        <div className="max-w-xs space-y-2 p-1 text-left">
                          <div className="space-y-0.5">
                            <Header3>Environment</Header3>
                            <Paragraph
                              variant="small"
                              className="text-wrap! text-text-dimmed"
                              spacing
                            >
                              This queue is limited by your environment's concurrency limit of{" "}
                              {environment.concurrencyLimit}.
                            </Paragraph>
                          </div>
                          <div className="space-y-0.5">
                            <Header3>User</Header3>
                            <Paragraph
                              variant="small"
                              className="text-wrap! text-text-dimmed"
                              spacing
                            >
                              This queue is limited by a concurrency limit set in your code.
                            </Paragraph>
                          </div>
                          <div className="space-y-0.5">
                            <Header3>Override</Header3>
                            <Paragraph
                              variant="small"
                              className="text-wrap! text-text-dimmed"
                              spacing
                            >
                              This queue's concurrency limit has been manually overridden from the
                              dashboard or API.
                            </Paragraph>
                          </div>
                        </div>
                      }
                    >
                      Limited by
                    </TableHeaderCell>
                    <TableHeaderCell className="w-[1%] pl-32">
                      <span className="sr-only">Pause/resume</span>
                    </TableHeaderCell>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {queues.length > 0 ? (
                    queues.map((queue) => {
                      const limit = queue.concurrencyLimit ?? environment.concurrencyLimit;
                      const isAtConcurrencyLimit = queue.running >= limit;
                      const isAtQueueLimit =
                        environment.queueSizeLimit !== null &&
                        queue.queued >= environment.queueSizeLimit;
                      const queueFilterableName = `${queue.type === "task" ? "task/" : ""}${
                        queue.name
                      }`;
                      return (
                        <TableRow key={queue.name}>
                          <TableCell>
                            <span className="flex items-center gap-2">
                              <QueueName {...queue} />
                              {queue.concurrency?.overriddenAt ? (
                                <SimpleTooltip
                                  button={
                                    <Badge variant="extra-small" className="text-text-bright">
                                      Concurrency limit overridden
                                    </Badge>
                                  }
                                  content="This queue's concurrency limit has been manually overridden from the dashboard or API."
                                  className="max-w-xs"
                                  disableHoverableContent
                                />
                              ) : null}
                              {queue.paused ? (
                                <Badge variant="extra-small" className="text-warning">
                                  Paused
                                </Badge>
                              ) : null}
                              {isAtQueueLimit ? (
                                <Badge variant="extra-small" className="text-error">
                                  At queue limit
                                </Badge>
                              ) : null}
                              {isAtConcurrencyLimit ? (
                                <Badge variant="extra-small" className="text-warning">
                                  At concurrency limit
                                </Badge>
                              ) : null}
                            </span>
                          </TableCell>
                          <TableCell
                            alignment="right"
                            className={cn(
                              "w-[1%] pl-16 tabular-nums",
                              queue.paused ? "opacity-50" : undefined,
                              isAtQueueLimit && "text-error"
                            )}
                          >
                            {queue.queued}
                          </TableCell>
                          <TableCell
                            alignment="right"
                            className={cn(
                              "w-[1%] pl-16 tabular-nums",
                              queue.paused ? "opacity-50" : undefined,
                              queue.running > 0 && "text-text-bright",
                              isAtConcurrencyLimit && "text-warning"
                            )}
                          >
                            {queue.running}
                          </TableCell>
                          <TableCell
                            alignment="right"
                            className={cn(
                              "w-[1%] pl-16 tabular-nums",
                              queue.paused ? "opacity-50" : undefined,
                              queue.concurrency?.overriddenAt && "font-medium text-text-bright"
                            )}
                          >
                            {limit}
                          </TableCell>
                          <TableCell
                            alignment="right"
                            className={cn(
                              "w-[1%] pl-16",
                              queue.paused ? "opacity-50" : undefined,
                              isAtConcurrencyLimit && "text-warning",
                              queue.concurrency?.overriddenAt && "font-medium text-text-bright"
                            )}
                          >
                            {queue.concurrency?.overriddenAt ? (
                              <span className="text-text-bright">Override</span>
                            ) : queue.concurrencyLimit ? (
                              "User"
                            ) : (
                              "Environment"
                            )}
                          </TableCell>
                          <TableCellMenu
                            isSticky
                            visibleButtons={
                              queue.paused && <QueuePauseResumeButton queue={queue} />
                            }
                            hiddenButtons={
                              !queue.paused && <QueuePauseResumeButton queue={queue} />
                            }
                            popoverContent={
                              <>
                                {queue.paused ? (
                                  <QueuePauseResumeButton
                                    queue={queue}
                                    variant="minimal/small"
                                    fullWidth
                                    showTooltip={false}
                                  />
                                ) : (
                                  <QueuePauseResumeButton
                                    queue={queue}
                                    variant="minimal/small"
                                    fullWidth
                                    showTooltip={false}
                                  />
                                )}

                                <PopoverMenuItem
                                  icon={RunsIcon}
                                  leadingIconClassName="text-runs"
                                  title="View all runs"
                                  to={v3RunsPath(organization, project, env, {
                                    queues: [queueFilterableName],
                                    period: "30d",
                                    rootOnly: false,
                                  })}
                                />
                                <PopoverMenuItem
                                  icon={RectangleStackIcon}
                                  leadingIconClassName="text-queues"
                                  title="View queued runs"
                                  to={v3RunsPath(organization, project, env, {
                                    queues: [queueFilterableName],
                                    statuses: ["PENDING"],
                                    period: "30d",
                                    rootOnly: false,
                                  })}
                                />
                                <PopoverMenuItem
                                  icon={Spinner}
                                  leadingIconClassName="text-queues animate-none"
                                  title="View running runs"
                                  to={v3RunsPath(organization, project, env, {
                                    queues: [queueFilterableName],
                                    statuses: ["DEQUEUED", "EXECUTING"],
                                    period: "30d",
                                    rootOnly: false,
                                  })}
                                />
                                <QueueOverrideConcurrencyButton
                                  queue={queue}
                                  environmentConcurrencyLimit={environment.concurrencyLimit}
                                />
                              </>
                            }
                          />
                        </TableRow>
                      );
                    })
                  ) : (
                    <TableRow>
                      <TableCell colSpan={7}>
                        <div className="grid place-items-center py-6 text-text-dimmed">
                          <Paragraph>
                            {hasFilters
                              ? "No queues found matching your filters"
                              : "No queues found"}
                          </Paragraph>
                        </div>
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </div>
          ) : (
            <div className="grid place-items-center py-6 text-text-dimmed">
              {totalQueues === 0 ? (
                <div className="pt-12">
                  <QueuesHasNoTasks />
                </div>
              ) : code === "engine-version" ? (
                <EngineVersionUpgradeCallout />
              ) : (
                <Callout variant="error">Something went wrong</Callout>
              )}
            </div>
          )}
        </div>
      </PageBody>
    </PageContainer>
  );
}

function BurstFactorTooltip({
  environment,
}: {
  environment: { burstFactor: number; concurrencyLimit: number };
}) {
  return (
    <InfoIconTooltip
      content={`Your single queue concurrency limit is capped at ${
        environment.concurrencyLimit
      }, but you can burst up to ${
        environment.burstFactor * environment.concurrencyLimit
      } when across multiple queues/tasks.`}
      contentClassName="max-w-xs"
    />
  );
}
