import { readExternalDeploymentIdAnnotation } from "@internal/run-engine";
import type { LoaderFunctionArgs } from "@remix-run/server-runtime";
import { typedjson } from "remix-typedjson";
import { $replica } from "~/db.server";
import { redirectWithErrorMessage } from "~/models/message.server";
import { findProjectBySlug } from "~/models/project.server";
import { handleQueueMutationAction } from "~/models/queueMutation.server";
import { findEnvironmentBySlug } from "~/models/runtimeEnvironment.server";
import { resolvePendingVersion } from "~/presenters/v3/PendingVersionPresenter.server";
import { resolveRunQueueMetrics } from "~/presenters/v3/RunQueueMetricsPresenter.server";
import { buildRunWaitingView } from "~/presenters/v3/RunWaitingPresenter.server";
import { isExplainedExpiry, NOT_STARTED_STATUSES } from "~/presenters/v3/runWaiting";
import { resolveProjectAuthScope } from "~/services/projectAuthScope.server";
import { rbac } from "~/services/rbac.server";
import { dashboardAction } from "~/services/routeBuilders/dashboardBuilder";
import { requireUserId } from "~/services/session.server";
import { v3RunParamsSchema, v3RunPath } from "~/utils/pathBuilder";
import { controlPlaneResolver } from "~/v3/runOpsMigration/controlPlaneResolver.server";
import { runStore } from "~/v3/runStore.server";

// Why a run that hasn't started is waiting, with the live counts and recent versions the run
// panel draws. Polled by the panel while the run waits, for as long as the run waits, so a tick
// reads only what moves: the panel says which status its view was built from (`have`), and while
// the run is still in it the versions, the pending-version reason, the permissions and the usual
// wait are not read again.
export async function loader({ request, params }: LoaderFunctionArgs) {
  const userId = await requireUserId(request);
  const { organizationSlug, projectParam, envParam, runParam } = v3RunParamsSchema.parse(params);
  const searchParams = new URL(request.url).searchParams;

  const run = await runStore.findRun(
    { friendlyId: runParam },
    {
      select: {
        status: true,
        createdAt: true,
        queuedAt: true,
        delayUntil: true,
        ttl: true,
        debounce: true,
        engine: true,
        projectId: true,
        runtimeEnvironmentId: true,
        taskIdentifier: true,
        queue: true,
        concurrencyKey: true,
        gates: true,
        statusReason: true,
        lockedById: true,
        lockedToVersionId: true,
        annotations: true,
        expiredAt: true,
      },
    }
  );
  // A run that isn't in Postgres yet (still buffered) has nothing newer to show: the panel keeps
  // the view it has. A 404 here would reach the run page's error boundary.
  if (!run) return typedjson({ view: null, unchanged: true, countsOnly: false });

  // Membership-scoped auth, matching the status and trace-chunk routes.
  const authorizedProject = await $replica.project.findFirst({
    where: {
      id: run.projectId,
      slug: projectParam,
      organization: { members: { some: { userId } } },
    },
    select: { id: true, organizationId: true },
  });
  if (!authorizedProject) throw new Response("Not found", { status: 404 });

  const environment = await controlPlaneResolver.resolveAuthenticatedEnv(run.runtimeEnvironmentId);
  if (!environment || environment.slug !== envParam) {
    throw new Response("Not found", { status: 404 });
  }

  const explainedExpiry = isExplainedExpiry(run.status, run.statusReason);
  const pendingVersionStatus =
    run.status === "PENDING_VERSION" || run.status === "WAITING_FOR_DEPLOY" || explainedExpiry;
  if (!NOT_STARTED_STATUSES.has(run.status) && !explainedExpiry) {
    return typedjson({ view: null, unchanged: false, countsOnly: false });
  }

  const sameStatus = searchParams.get("have") === run.status;
  // A run waiting for a version isn't in a queue: nothing about it moves until its status does.
  if (sameStatus && pendingVersionStatus) {
    return typedjson({ view: null, unchanged: true, countsOnly: false });
  }
  // A queued run in the same status: the live counts and what they mean, nothing else.
  const countsOnly = sameStatus;

  const lockedWorker = await controlPlaneResolver.resolveRunLockedWorker({
    lockedById: run.lockedById,
    lockedToVersionId: run.lockedToVersionId,
  });
  const lockedVersion = lockedWorker?.lockedToVersion?.version;

  const [queueMetrics, pendingVersion, auth] = await Promise.all([
    resolveRunQueueMetrics({
      request,
      userId,
      organizationSlug,
      projectParam,
      envParam,
      run: {
        environmentId: run.runtimeEnvironmentId,
        status: run.status,
        engine: run.engine,
        queue: { name: run.queue, concurrencyKey: run.concurrencyKey },
        gates: run.gates,
      },
      knownDelays: countsOnly
        ? { p50: knownDelay(searchParams, "p50"), p95: knownDelay(searchParams, "p95") }
        : undefined,
    }),
    pendingVersionStatus
      ? resolvePendingVersion({
          environmentId: run.runtimeEnvironmentId,
          taskIdentifier: run.taskIdentifier,
          queueName: run.queue,
          statusReason: run.statusReason ?? undefined,
          lockedVersion,
          externalDeploymentId: readExternalDeploymentIdAnnotation(run.annotations),
        })
      : null,
    countsOnly
      ? null
      : rbac.authenticateSession(request, {
          userId,
          organizationId: authorizedProject.organizationId,
          projectId: authorizedProject.id,
        }),
  ]);

  return typedjson({
    unchanged: false,
    // The panel keeps the permissions of the view it has.
    countsOnly,
    view: await buildRunWaitingView({
      run: {
        status: run.status,
        createdAt: run.createdAt,
        queuedAt: run.queuedAt,
        delayUntil: run.delayUntil,
        ttl: run.ttl,
        debounce: debounceOptions(run.debounce),
        statusReason: run.statusReason,
        expiredAt: run.expiredAt,
        environmentId: run.runtimeEnvironmentId,
        taskIdentifier: run.taskIdentifier,
        queueName: run.queue,
        lockedVersion,
      },
      queueMetrics,
      pendingVersion,
      canManageQueues: !!auth && auth.ok && auth.ability.can("write", { type: "tasks" }),
    }),
  });
}

/** A delay percentile the panel passes back, in milliseconds. */
function knownDelay(searchParams: URLSearchParams, key: string): number | null {
  const raw = searchParams.get(key);
  if (raw === null) return null;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

function debounceOptions(
  debounce: unknown
): { key: string; delay?: string; maxDelay?: string } | null {
  const d = debounce as { key?: unknown; delay?: unknown; maxDelay?: unknown } | null;
  if (typeof d?.key !== "string") return null;
  return {
    key: d.key,
    delay: typeof d.delay === "string" ? d.delay : undefined,
    maxDelay: typeof d.maxDelay === "string" ? d.maxDelay : undefined,
  };
}

// Resume (or pause) the run's queue from the panel, with the queues page's action and permission,
// then go back to the run.
export const action = dashboardAction(
  {
    params: v3RunParamsSchema,
    context: (params) => resolveProjectAuthScope(params.organizationSlug, params.projectParam),
    authorization: {
      action: "write",
      resource: { type: "tasks" },
      message: "With your current role, you can't manage queues.",
    },
  },
  async ({ request, params, user }) => {
    const { organizationSlug, projectParam, envParam, runParam } = v3RunParamsSchema.parse(params);
    const formData = await request.formData();

    const runPath = v3RunPath(
      { slug: organizationSlug },
      { slug: projectParam },
      { slug: envParam },
      { friendlyId: runParam }
    );
    // Only a path on this run's page, so the form can't redirect anywhere else.
    const redirectTo = formData.get("redirectTo");
    const redirectPath =
      typeof redirectTo === "string" && redirectTo.startsWith(`${runPath}?`) ? redirectTo : runPath;

    const project = await findProjectBySlug(organizationSlug, projectParam, user.id);
    if (!project) throw new Response(undefined, { status: 404, statusText: "Project not found" });
    const environment = await findEnvironmentBySlug(project.id, envParam, user.id);
    if (!environment) {
      throw new Response(undefined, { status: 404, statusText: "Environment not found" });
    }
    if (environment.archivedAt) {
      return redirectWithErrorMessage(redirectPath, request, "This branch is archived");
    }

    const result = await handleQueueMutationAction({
      request,
      environment,
      userId: user.id,
      formData,
      redirectPath,
    });
    return result ?? redirectWithErrorMessage(redirectPath, request, "Something went wrong");
  }
);
