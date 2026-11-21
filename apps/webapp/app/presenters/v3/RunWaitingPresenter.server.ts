import { CURRENT_DEPLOYMENT_LABEL } from "@trigger.dev/core/v3/isomorphic";
import { $replica } from "~/db.server";
import type { PendingVersionView } from "./PendingVersionPresenter.server";
import type { RunQueueMetrics } from "./RunQueueMetricsPresenter.server";
import { environmentFullTitle } from "~/components/environments/EnvironmentLabel";
import { devPresence } from "./DevPresence.server";
import {
  describeNotStarted,
  isExplainedExpiry,
  NOT_STARTED_STATUSES,
  type RunWaitingView,
  type WaitingVersion,
} from "./runWaiting";

// How many recent versions the waiting UI shows.
const VERSION_TRAIL_LENGTH = 5;

/** The run fields the answer needs, from the span loader or the polling route. */
export type NotStartedRun = {
  status: string;
  createdAt: Date;
  queuedAt: Date | null;
  delayUntil: Date | null;
  ttl: string | null;
  debounce: { key: string; delay?: string; maxDelay?: string } | null;
  /** Only read for an expired run, to explain it. */
  statusReason: string | null | undefined;
  expiredAt: Date | null | undefined;
  environmentId: string;
  taskIdentifier: string;
  queueName: string;
  lockedVersion: string | undefined;
};

/**
 * Everything the run page needs to show why a run hasn't started: the answer (group, reason,
 * actions, deadline), the live counts along the run's path (queue, key, environment) and the
 * environment's last few versions with whether each has the run's task and queue. Null once the
 * run has started.
 */
export async function buildRunWaitingView(input: {
  run: NotStartedRun;
  queueMetrics: RunQueueMetrics | null;
  pendingVersion: PendingVersionView | null;
  canManageQueues: boolean;
}): Promise<RunWaitingView | null> {
  const { run, queueMetrics, pendingVersion } = input;
  if (!NOT_STARTED_STATUSES.has(run.status) && !isExplainedExpiry(run.status, run.statusReason)) {
    return null;
  }

  const [environment, taskQueue, deploying] = await Promise.all([
    $replica.runtimeEnvironment.findFirst({
      where: { id: run.environmentId },
      select: {
        type: true,
        slug: true,
        paused: true,
        pauseSource: true,
        branchName: true,
        maximumConcurrencyLimit: true,
      },
    }),
    // The queue metrics are behind a flag; the paused state isn't.
    queueMetrics
      ? null
      : $replica.taskQueue.findFirst({
          where: { runtimeEnvironmentId: run.environmentId, name: run.queueName },
          select: { friendlyId: true, paused: true },
        }),
    // A queued run locked to a version whose deploy hasn't finished: the engine keeps it queued
    // until the deploy lands. Unique on (environmentId, version).
    run.status === "PENDING" && run.lockedVersion
      ? $replica.workerDeployment.findFirst({
          where: {
            environmentId: run.environmentId,
            version: run.lockedVersion,
            status: { in: ["PENDING", "INSTALLING", "BUILDING", "DEPLOYING"] },
          },
          select: { version: true, shortCode: true, status: true, createdAt: true },
        })
      : null,
  ]);
  const environmentType = environment?.type ?? "PRODUCTION";
  const devConnected =
    environmentType === "DEVELOPMENT" ? await devPresence.isConnected(run.environmentId) : null;
  const queuePaused = queueMetrics?.paused ?? taskQueue?.paused ?? false;
  const waiting = queueMetrics?.waiting ?? null;

  const notStarted = describeNotStarted({
    ...run,
    deployingVersion: deploying?.version ?? null,
    now: Date.now(),
    environment: {
      type: environmentType,
      name: environment
        ? environmentFullTitle({ type: environment.type, branchName: environment.branchName })
        : "This environment",
      paused: environment?.paused ?? false,
      pauseSource: environment?.pauseSource ?? null,
      devConnected,
    },
    queue: { name: run.queueName, paused: queuePaused },
    waiting,
    pendingVersion,
  });
  if (!notStarted) return null;

  const versions =
    (notStarted.group === "needsDeploy" || notStarted.group === "wontStart") &&
    notStarted.cause !== "externalExpired"
      ? await versionTrail({ ...run, environmentType })
      : [];

  return {
    status: run.status,
    notStarted,
    createdAt: run.createdAt,
    environmentType,
    taskIdentifier: run.taskIdentifier,
    queue: {
      friendlyId: queueMetrics?.queueFriendlyId ?? taskQueue?.friendlyId ?? null,
      name: run.queueName,
      paused: queuePaused,
      queued: waiting?.queued ?? null,
      running: waiting?.running ?? null,
      limit: waiting?.concurrencyLimit ?? null,
    },
    key: waiting?.concurrencyKey
      ? {
          key: waiting.concurrencyKey.key,
          queued: waiting.concurrencyKey.queued,
          running: waiting.concurrencyKey.running,
          limit: waiting.concurrencyKey.limitOverride ?? waiting.concurrencyLimit,
        }
      : null,
    total: waiting?.total ?? null,
    limits: waiting?.limits ?? [],
    env: waiting
      ? {
          ...waiting.env,
          paused: environment?.paused ?? false,
          pauseSource: environment?.pauseSource ?? null,
        }
      : environment
        ? {
            running: 0,
            limit: environment.maximumConcurrencyLimit,
            baseLimit: environment.maximumConcurrencyLimit,
            paused: environment.paused,
            pauseSource: environment.pauseSource,
          }
        : null,
    usualWait: waiting ? { p50Ms: waiting.delayP50Ms, p95Ms: waiting.delayP95Ms } : null,
    deployingVersion: deploying
      ? {
          version: deploying.version,
          shortCode: deploying.shortCode,
          status: deploying.status,
          since: deploying.createdAt,
        }
      : null,
    versions,
    lockedVersion: run.lockedVersion ?? null,
    pending: pendingVersion,
    canManageQueues: input.canManageQueues,
  };
}

// The newest versions in the environment, oldest first, plus the locked version when it's older.
// Deployed environments read deployments (indexed on environmentId, createdAt); dev reads workers.
async function versionTrail(input: {
  environmentId: string;
  environmentType: string;
  taskIdentifier: string;
  queueName: string;
  lockedVersion: string | undefined;
}): Promise<WaitingVersion[]> {
  const workerSelect = {
    id: true,
    version: true,
    createdAt: true,
    tasks: { where: { slug: input.taskIdentifier }, select: { id: true } },
    queues: { where: { name: input.queueName }, select: { id: true } },
  } as const;

  if (input.environmentType === "DEVELOPMENT") {
    const workers = await $replica.backgroundWorker.findMany({
      where: { runtimeEnvironmentId: input.environmentId },
      orderBy: { createdAt: "desc" },
      take: VERSION_TRAIL_LENGTH,
      select: workerSelect,
    });
    return workers.reverse().map((worker, i, all) => ({
      version: worker.version,
      shortCode: null,
      at: worker.createdAt,
      hasTask: worker.tasks.length > 0,
      hasQueue: worker.queues.length > 0,
      current: i === all.length - 1,
      locked: worker.version === input.lockedVersion,
    }));
  }

  const deploymentSelect = {
    version: true,
    shortCode: true,
    createdAt: true,
    deployedAt: true,
    worker: { select: workerSelect },
  } as const;

  const [deployments, promotion] = await Promise.all([
    $replica.workerDeployment.findMany({
      where: { environmentId: input.environmentId, status: "DEPLOYED" },
      orderBy: { createdAt: "desc" },
      take: VERSION_TRAIL_LENGTH,
      select: deploymentSelect,
    }),
    $replica.workerDeploymentPromotion.findFirst({
      where: { environmentId: input.environmentId, label: CURRENT_DEPLOYMENT_LABEL },
      select: { deployment: { select: { version: true } } },
    }),
  ]);

  if (input.lockedVersion && !deployments.some((d) => d.version === input.lockedVersion)) {
    const locked = await $replica.workerDeployment.findFirst({
      where: { environmentId: input.environmentId, version: input.lockedVersion },
      select: deploymentSelect,
    });
    if (locked) deployments.push(locked);
  }

  const currentVersion = promotion?.deployment.version;
  return deployments
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
    .map((d) => ({
      version: d.version,
      shortCode: d.shortCode,
      at: d.deployedAt ?? d.createdAt,
      hasTask: (d.worker?.tasks.length ?? 0) > 0,
      hasQueue: (d.worker?.queues.length ?? 0) > 0,
      current: d.version === currentVersion,
      locked: d.version === input.lockedVersion,
    }));
}
