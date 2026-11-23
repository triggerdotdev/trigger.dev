import type { TaskTriggerSource } from "@trigger.dev/database";
import { z } from "zod";
import { DirectionSchema } from "~/components/ListPagination";
import { storedQueueName } from "~/components/queues/queue-name";
import { timeFilterFromTo } from "~/components/runs/v3/SharedFilters";
import { $replica } from "~/db.server";
import { redirectWithErrorMessage } from "~/models/message.server";
import { findProjectWithOrgFlagsBySlug } from "~/models/project.server";
import { handleQueueMutationAction } from "~/models/queueMutation.server";
import { findEnvironmentBySlug } from "~/models/runtimeEnvironment.server";
import { NextRunListPresenter } from "~/presenters/v3/NextRunListPresenter.server";
import { QueueRetrievePresenter } from "~/presenters/v3/QueueRetrievePresenter.server";
import { getRunColumnsForSelect } from "~/presenters/v3/runColumnsFromRequest.server";
import { type TaskActivity, TaskDetailPresenter } from "~/presenters/v3/TaskDetailPresenter.server";
import { clickhouseFactory } from "~/services/clickhouse/clickhouseFactoryInstance.server";
import { resolveProjectAuthScope } from "~/services/projectAuthScope.server";
import { rbac } from "~/services/rbac.server";
import { dashboardAction } from "~/services/routeBuilders/dashboardBuilder";
import { RunsListQueryError } from "~/services/runsRepository/runsRepository.server";
import { requireUser } from "~/services/session.server";
import { throwNotFound } from "~/utils/httpErrors";
import { EnvironmentParamSchema } from "~/utils/pathBuilder";
import { parseFiniteInt } from "~/utils/searchParams";
import { canAccessQueueMetricsUi } from "~/v3/canAccessQueueMetricsUi.server";
import { canUseAlertsList } from "~/v3/canUseAlertsList.server";
import { findCurrentVersion } from "~/v3/models/workerDeployment.server";
import { engine } from "~/v3/runEngine.server";

const TaskPageParamsSchema = EnvironmentParamSchema.extend({
  taskParam: z.string(),
});

/** How far back the Queue tab looks for runs still waiting, like the queue page's link. */
const QUEUED_RUNS_PERIOD = "30d";

/**
 * Everything the task page shows, for the standard and scheduled routes. Postgres and Redis
 * (task, queue, live counts, current version) are awaited; the ClickHouse parts (runs chart, runs
 * table, queued runs) are promises the route defers, so every tab's data arrives with the page
 * and switching tabs makes no request.
 */
export async function loadTaskDetailPage({
  request,
  params,
  triggerSource,
  defaultTab = "runs",
}: {
  request: Request;
  params: unknown;
  triggerSource: TaskTriggerSource;
  /** The tab the page opens on; the runs list only pages when Runs is the open tab. */
  defaultTab?: string;
}) {
  const user = await requireUser(request);
  const userId = user.id;
  const { organizationSlug, projectParam, envParam, taskParam } =
    TaskPageParamsSchema.parse(params);

  const project = await findProjectWithOrgFlagsBySlug(organizationSlug, projectParam, userId);
  if (!project) throwNotFound("Project not found");

  const environment = await findEnvironmentBySlug(project.id, envParam, userId);
  if (!environment) throwNotFound("Environment not found");

  const [clickhouse, runsListClickhouse] = await Promise.all([
    clickhouseFactory.getClickhouseForOrganization(project.organizationId, "standard"),
    clickhouseFactory.getClickhouseForOrganization(project.organizationId, "runsList"),
  ]);

  const presenter = new TaskDetailPresenter($replica, clickhouse);
  const task = await presenter.findTask({
    projectId: project.id,
    environmentId: environment.id,
    environmentType: environment.type,
    taskSlug: taskParam,
    expectedTriggerSource: triggerSource,
  });
  if (!task) throwNotFound("Task not found");

  const [auth, alertsEnabled, queueMetricsUi, currentVersion, queueResult] = await Promise.all([
    rbac.authenticateSession(request, {
      userId,
      organizationId: project.organizationId,
      projectId: project.id,
    }),
    canUseAlertsList({
      orgFeatureFlags: (project.organization.featureFlags as Record<string, unknown>) ?? {},
      user,
    }),
    canAccessQueueMetricsUi({ request, userId, organizationSlug }),
    // One lookup per page load for the header, the rail and every version label in the tables.
    findCurrentVersion(environment, $replica),
    task.queue
      ? new QueueRetrievePresenter().call({ environment, queueInput: task.queue.friendlyId })
      : undefined,
  ]);

  const canWriteTasks = auth.ok && auth.ability.can("write", { type: "tasks" });
  const canManageBilling = auth.ok && auth.ability.can("manage", { type: "billing" });

  // Live queue state from Redis: the same reads the queue page makes.
  const queue = queueResult?.success ? queueResult.queue : null;
  const queueFullName = queue ? storedQueueName(queue) : null;
  const oldestQueuedAt =
    queue && queueFullName && queue.queued > 0
      ? ((await engine.oldestMessageInQueue(environment, queueFullName)) ?? null)
      : null;

  const url = new URL(request.url);
  const period = url.searchParams.get("period") ?? undefined;
  const from = parseFiniteInt(url.searchParams.get("from"));
  const to = parseFiniteInt(url.searchParams.get("to"));
  const runsTabOpen = (url.searchParams.get("tab") ?? defaultTab) === "runs";
  const cursor = runsTabOpen ? (url.searchParams.get("cursor") ?? undefined) : undefined;
  const direction = DirectionSchema.catch("forward").parse(
    url.searchParams.get("direction") ?? undefined
  );
  const versions = url.searchParams.getAll("versions").filter((v) => v.length > 0);
  const time = timeFilterFromTo({ period, from, to, defaultPeriod: "7d" });

  const activity = presenter
    .getActivity({
      organizationId: project.organizationId,
      projectId: project.id,
      environmentId: environment.id,
      taskSlug: task.slug,
      from: time.from,
      to: time.to,
    })
    .catch(() => ({ data: [], statuses: [] }) satisfies TaskActivity);

  const runListPresenter = new NextRunListPresenter($replica, runsListClickhouse);
  const columns = getRunColumnsForSelect(request);

  const runList = runListPresenter
    .call(project.organizationId, environment.id, {
      userId,
      projectId: project.id,
      tasks: [task.slug],
      versions: versions.length > 0 ? versions : undefined,
      period,
      from,
      to,
      cursor,
      direction,
      includeHasAnyRuns: true,
      columns,
    })
    .catch((error) => {
      if (error instanceof RunsListQueryError) {
        throw error;
      }
      return null;
    });

  // The queue's waiting runs, every task in it, newest page only (the toolbar links out for more).
  // Null when nothing is waiting: the usual case, and then there's no list to read. The period
  // can't be narrowed to the queue's oldest message: a delayed run was created before its place
  // in the queue, and runs with a concurrency key wait in queues of their own.
  const queuedRuns =
    queue && queueFullName && queue.queued > 0
      ? runListPresenter
          .call(project.organizationId, environment.id, {
            userId,
            projectId: project.id,
            queues: [queueFullName],
            statuses: ["PENDING"],
            period: QUEUED_RUNS_PERIOD,
            columns,
          })
          .catch(() => null)
      : null;

  return {
    user,
    project,
    environment,
    time,
    /** What the page renders; the route spreads it into `typeddefer` so the promises stream. */
    page: {
      task,
      currentVersion,
      alertsEnabled,
      canWriteTasks,
      canManageBilling,
      queue,
      queueFullName,
      queuedRunsPeriod: QUEUED_RUNS_PERIOD,
      oldestQueuedAt,
      loadedAt: Date.now(),
      // The override dialog caps at the environment's concurrency limit.
      environmentConcurrencyLimit: environment.maximumConcurrencyLimit,
      // Flag-gated queue metrics UI: the backlog chart and the queue page link.
      queueMetricIds: queueMetricsUi
        ? {
            organizationId: project.organizationId,
            projectId: project.id,
            environmentId: environment.id,
          }
        : null,
      activity,
      runList,
      queuedRuns,
    },
  };
}

export type TaskDetailPageData = Awaited<ReturnType<typeof loadTaskDetailPage>>["page"];

/** Pause, resume and override the task's queue from its Queue tab, then come back to the tab. */
export const taskQueueAction = dashboardAction(
  {
    // Environment params only: the agent route names its slug `agentParam`.
    params: EnvironmentParamSchema,
    context: (params) => resolveProjectAuthScope(params.organizationSlug, params.projectParam),
    authorization: {
      action: "write",
      resource: { type: "tasks" },
      message: "With your current role, you can't manage queues.",
    },
  },
  async ({ request, params, user }) => {
    const { organizationSlug, projectParam, envParam } = params;
    const url = new URL(request.url);
    const redirectPath = `${url.pathname}${url.search}`;

    if (request.method.toLowerCase() !== "post") {
      return redirectWithErrorMessage(redirectPath, request, "Wrong method");
    }

    const project = await findProjectWithOrgFlagsBySlug(organizationSlug, projectParam, user.id);
    if (!project) throwNotFound("Project not found");

    const environment = await findEnvironmentBySlug(project.id, envParam, user.id);
    if (!environment) throwNotFound("Environment not found");

    if (environment.archivedAt) {
      return redirectWithErrorMessage(redirectPath, request, "This branch is archived");
    }

    const result = await handleQueueMutationAction({
      request,
      environment,
      userId: user.id,
      formData: await request.formData(),
      redirectPath,
    });
    if (result) return result;

    return redirectWithErrorMessage(redirectPath, request, "Something went wrong");
  }
);
