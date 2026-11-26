import type { PrismaClientOrTransaction } from "@trigger.dev/database";
import { findCurrentDeployment } from "~/v3/models/workerDeployment.server";
import {
  readSkewProtectionThresholds,
  type SkewProtectionThreshold,
  type SkewProtectionThresholdSetBy,
} from "~/v3/services/skewProtectionThresholds.server";
import { compareDeploymentVersions } from "~/v3/utils/deploymentVersions";
import {
  currentDeploymentVersion,
  type SkewProtectionThresholdChangeKind,
  type SkewProtectionThresholdChangeSource,
} from "~/v3/services/skewProtectionThreshold.server";

// Read models for the skew protection thresholds: their state (API), the Session upgrades page, the
// change history, whether a task's page offers Upgrade sessions, and what that dialog shows.

/** Shown for a user with no display name or name. */
const TEAM_MEMBER = "a team member";

type SkewProtectionThresholdItem = {
  version: string;
  setAt: string;
  /** No user id or email; the name is for the dashboard only. */
  setBy: { type: SkewProtectionThresholdSetBy["type"]; name: string | null } | null;
};

/** The API's view. A secret key is a machine credential, so `setBy` names no person. */
type SkewProtectionThresholdWithDeployment = Omit<SkewProtectionThresholdItem, "setBy"> & {
  setBy: { type: SkewProtectionThresholdSetBy["type"] } | null;
  deploymentId: string | null;
};

type SkewProtectionThresholdState = {
  currentVersion: string | null;
  /** The environment's threshold. */
  threshold: SkewProtectionThresholdWithDeployment | null;
  /** Each task's own threshold, by task id order. */
  tasks: Array<SkewProtectionThresholdWithDeployment & { task: string }>;
};

function toItem(threshold: SkewProtectionThreshold): SkewProtectionThresholdItem {
  return {
    version: threshold.version,
    setAt: threshold.setAt,
    setBy: threshold.setBy
      ? { type: threshold.setBy.type, name: threshold.setBy.name ?? null }
      : null,
  };
}

export async function getSkewProtectionThreshold(
  prisma: PrismaClientOrTransaction,
  environmentId: string
): Promise<SkewProtectionThresholdState> {
  const [value, currentVersion] = await Promise.all([
    prisma.runtimeEnvironment
      .findFirst({ where: { id: environmentId }, select: { skewProtectionThresholds: true } })
      .then((environment) => environment?.skewProtectionThresholds),
    currentDeploymentVersion(prisma, environmentId),
  ]);

  const thresholds = readSkewProtectionThresholds(value, environmentId);
  const versions = [
    ...new Set([
      ...(thresholds.environment ? [thresholds.environment.version] : []),
      ...[...thresholds.tasks.values()].map((threshold) => threshold.version),
    ]),
  ];
  // One read for every threshold's deployment; none when nothing is set.
  const deployments =
    versions.length > 0
      ? await prisma.workerDeployment.findMany({
          // oxlint-disable-next-line trigger-prisma/no-unbounded-list-filter -- at most MAX_TASK_THRESHOLDS + 1 versions, on the (environmentId, version) unique index
          where: { environmentId, version: { in: versions } },
          select: { version: true, friendlyId: true },
        })
      : [];
  const deploymentIds = new Map(deployments.map((d) => [d.version, d.friendlyId]));
  const withDeployment = (threshold: SkewProtectionThreshold) => ({
    version: threshold.version,
    setAt: threshold.setAt,
    setBy: threshold.setBy ? { type: threshold.setBy.type } : null,
    deploymentId: deploymentIds.get(threshold.version) ?? null,
  });

  return {
    currentVersion: currentVersion ?? null,
    threshold: thresholds.environment ? withDeployment(thresholds.environment) : null,
    tasks: [...thresholds.tasks]
      .map(([task, threshold]) => ({ task, ...withDeployment(threshold) }))
      .sort((a, b) => (a.task < b.task ? -1 : a.task > b.task ? 1 : 0)),
  };
}

/**
 * The API's layout of the state: `tasks` keyed by task id. Built with `Object.fromEntries`, which
 * defines own properties, so a task named `__proto__` is just another key.
 */
export function skewProtectionThresholdApiResponse(state: SkewProtectionThresholdState) {
  return {
    currentVersion: state.currentVersion,
    threshold: state.threshold,
    tasks: Object.fromEntries(state.tasks.map(({ task, ...threshold }) => [task, threshold])),
  };
}

export type SkewProtectionThresholdChangeItem = {
  id: string;
  /** The task whose threshold changed; null for the environment's. */
  task: string | null;
  kind: SkewProtectionThresholdChangeKind;
  version: string;
  currentVersion: string | null;
  source: SkewProtectionThresholdChangeSource;
  /**
   * The user's display name or name ("a team member" when they have neither; never their email),
   * or the API key name; null when no actor was recorded.
   */
  actorName: string | null;
  createdAt: Date;
};

/**
 * The thresholds a rollback dialog warns about: the environment's version and each task's. The
 * dialog decides which of them the rollback clears. One read of the environment row.
 */
export async function getSkewProtectionThresholdsForRollback(
  prisma: PrismaClientOrTransaction,
  environmentId: string
): Promise<{
  thresholdVersion?: string;
  taskThresholds: Array<{ task: string; version: string }>;
}> {
  const environment = await prisma.runtimeEnvironment.findFirst({
    where: { id: environmentId },
    select: { type: true, skewProtectionThresholds: true },
  });
  // Thresholds don't apply in development.
  if (!environment || environment.type === "DEVELOPMENT") return { taskThresholds: [] };

  const thresholds = readSkewProtectionThresholds(
    environment.skewProtectionThresholds,
    environmentId
  );
  return {
    thresholdVersion: thresholds.environment?.version,
    taskThresholds: [...thresholds.tasks].map(([task, threshold]) => ({
      task,
      version: threshold.version,
    })),
  };
}

/** The environment's latest threshold changes, newest first. */
export async function getSkewProtectionThresholdHistory(
  prisma: PrismaClientOrTransaction,
  params: { environmentId: string; take?: number }
): Promise<SkewProtectionThresholdChangeItem[]> {
  const rows = await prisma.skewProtectionThresholdChange.findMany({
    where: { environmentId: params.environmentId },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: params.take ?? 20,
  });

  const userIds = [...new Set(rows.flatMap((row) => (row.userId ? [row.userId] : [])))];
  const users =
    userIds.length > 0
      ? await prisma.user.findMany({
          // oxlint-disable-next-line trigger-prisma/no-unbounded-list-filter -- at most `take` (20) distinct ids from one history page
          where: { id: { in: userIds } },
          select: { id: true, displayName: true, name: true },
        })
      : [];
  const userNames = new Map(users.map((user) => [user.id, user.displayName ?? user.name]));

  return rows.map((row) => ({
    id: row.id,
    task: row.taskIdentifier,
    kind: row.kind as SkewProtectionThresholdChangeKind,
    version: row.version,
    currentVersion: row.currentVersion,
    source: row.source as SkewProtectionThresholdChangeSource,
    actorName: row.userId ? (userNames.get(row.userId) ?? TEAM_MEMBER) : (row.apiKeyName ?? null),
    createdAt: row.createdAt,
  }));
}

/**
 * Whether a task's page offers Upgrade sessions: not in development (thresholds don't apply
 * there), and with `onlyIfTaskHasSessions` (a task that isn't an agent) only once the task has
 * had a session in the environment. The only query is that session check.
 */
export async function showsUpgradeSessions(
  prisma: PrismaClientOrTransaction,
  params: {
    environment: { id: string; type: string };
    taskIdentifier: string;
    onlyIfTaskHasSessions?: boolean;
  }
): Promise<boolean> {
  if (params.environment.type === "DEVELOPMENT") return false;
  if (!params.onlyIfTaskHasSessions) return true;
  // Uses the Session (runtimeEnvironmentId, taskIdentifier) index.
  const session = await prisma.session.findFirst({
    where: { runtimeEnvironmentId: params.environment.id, taskIdentifier: params.taskIdentifier },
    select: { id: true },
  });
  return session !== null;
}

export type SkewProtectionThresholdChoices = {
  currentVersion: string | null;
  /** Deployed versions at or below the current one, newest first: of the task, or of the environment. */
  versions: string[];
  /**
   * The threshold the dialog's Threshold row shows: the task's own, else the environment's (which
   * covers the task too); without a task, the environment's.
   */
  threshold:
    | (SkewProtectionThresholdItem & { scope: "task" | "environment"; byYou: boolean })
    | null;
  /**
   * With a task that is a `chat.agent` in the current deployment: its `versionSkew`, or null when
   * that deployment's SDK doesn't report it. Absent for anything else, `chat.customAgent` included
   * (it has no setting of its own: `chat.createSession` takes one per call).
   */
  versionSkew?: string | null;
};

/** What an agent's code says about moving its sessions, as its current deployment reports it. */
type AgentInCode =
  | { type: "versionSkew"; versionSkew: string }
  /** A `chat.customAgent`: `chat.createSession` takes the setting per call. */
  | { type: "custom" }
  /** The agent's SDK is older than the one that reports `versionSkew`. */
  | { type: "not-reported" }
  /** Has a threshold of its own but isn't an agent in the current deployment. */
  | { type: "not-in-current" };

function agentInCode(config: unknown): AgentInCode {
  const versionSkew = (config as { versionSkew?: unknown } | null)?.versionSkew;
  if (typeof versionSkew === "string") return { type: "versionSkew", versionSkew };
  // The SDK that reports `versionSkew` also reports `turnHandover`: on it, an agent without
  // `versionSkew` is a `chat.customAgent`.
  const reportsSettings = (config as { turnHandover?: unknown } | null)?.turnHandover === true;
  return reportsSettings ? { type: "custom" } : { type: "not-reported" };
}

export type SkewProtectionAgentRow = {
  task: string;
  inCode: AgentInCode;
  /** The threshold its sessions follow: the higher of its own and the environment's. */
  threshold:
    | (SkewProtectionThresholdItem & { scope: "task" | "environment"; byYou: boolean })
    | null;
  /** Its own threshold's version when the environment's is higher, so its own isn't in force. */
  lowerOwnVersion: string | null;
};

/**
 * The Session upgrades page: the environment's threshold, one row per agent in the current
 * deployment (and per task threshold on anything else, so it can still be cleared), and the
 * history. Five indexed reads: promotion with deployment and worker, environment, agents on
 * (workerId, slug), history and its users.
 */
export async function getSkewProtectionPage(
  prisma: PrismaClientOrTransaction,
  params: { environmentId: string; userId: string }
) {
  const { environmentId } = params;
  const [current, environment, changes] = await Promise.all([
    findCurrentDeployment(environmentId, prisma),
    prisma.runtimeEnvironment.findFirst({
      where: { id: environmentId },
      select: {
        skewProtectionThresholds: true,
      },
    }),
    getSkewProtectionThresholdHistory(prisma, { environmentId }),
  ]);
  const thresholds = readSkewProtectionThresholds(
    environment?.skewProtectionThresholds,
    environmentId
  );
  const agents = current?.workerId
    ? await prisma.backgroundWorkerTask.findMany({
        where: { workerId: current.workerId, triggerSource: "AGENT" },
        select: { slug: true, config: true },
      })
    : [];

  const byYou = (threshold: SkewProtectionThreshold) =>
    threshold.setBy?.type === "user" && threshold.setBy.id === params.userId;
  // The higher of the two applies (sessionVersionFloorFor).
  const thresholdFor = (
    task: string
  ): Pick<SkewProtectionAgentRow, "threshold" | "lowerOwnVersion"> => {
    const own = thresholds.tasks.get(task);
    const environment = thresholds.environment;
    if (own && (!environment || compareDeploymentVersions(own.version, environment.version) >= 0)) {
      return {
        threshold: { ...toItem(own), scope: "task", byYou: byYou(own) },
        lowerOwnVersion: null,
      };
    }
    return {
      threshold: environment
        ? { ...toItem(environment), scope: "environment", byYou: byYou(environment) }
        : null,
      lowerOwnVersion: own?.version ?? null,
    };
  };
  const rows: SkewProtectionAgentRow[] = agents.map((agent) => ({
    task: agent.slug,
    inCode: agentInCode(agent.config),
    ...thresholdFor(agent.slug),
  }));
  const agentSlugs = new Set(agents.map((agent) => agent.slug));
  for (const task of thresholds.tasks.keys()) {
    if (!agentSlugs.has(task)) {
      rows.push({ task, inCode: { type: "not-in-current" }, ...thresholdFor(task) });
    }
  }
  rows.sort((a, b) => (a.task < b.task ? -1 : a.task > b.task ? 1 : 0));

  const shown = thresholds.environment;
  return {
    currentVersion: current?.version ?? null,
    threshold: shown ? { ...toItem(shown), byYou: byYou(shown) } : null,
    agents: rows,
    changes,
  };
}

const MAX_CHOICES = 50;

/**
 * What the Upgrade sessions dialog shows, loaded when it opens: the threshold for its scope (one
 * task, or the environment), the versions it can be set to, and with a task the agent's
 * `versionSkew`.
 */
export async function getSkewProtectionThresholdChoices(
  prisma: PrismaClientOrTransaction,
  params: { environmentId: string; userId: string; task?: string }
): Promise<SkewProtectionThresholdChoices> {
  const { environmentId, task } = params;
  const [current, environment] = await Promise.all([
    findCurrentDeployment(environmentId, prisma),
    prisma.runtimeEnvironment.findFirst({
      where: { id: environmentId },
      select: {
        skewProtectionThresholds: true,
      },
    }),
  ]);
  const thresholds = readSkewProtectionThresholds(
    environment?.skewProtectionThresholds,
    environmentId
  );
  const own = task !== undefined ? thresholds.tasks.get(task) : undefined;
  const shown = own ?? thresholds.environment;
  const currentVersion = current?.version ?? null;
  const choices: SkewProtectionThresholdChoices = {
    currentVersion,
    versions: [],
    threshold: shown
      ? {
          ...toItem(shown),
          scope: own ? "task" : "environment",
          byYou: shown.setBy?.type === "user" && shown.setBy.id === params.userId,
        }
      : null,
  };
  if (!current || !currentVersion) return choices;

  let versions: string[];
  if (task !== undefined) {
    // The environment's newest deployed versions on (environmentId, createdAt), then which of
    // their workers have the task on (workerId, slug): two bounded reads, where filtering the
    // task's rows by deployment status read every deployment the task was ever in.
    // Only up to the current one: after a rollback past the newest ones they'd fill the take.
    const deployments = await prisma.workerDeployment.findMany({
      where: {
        environmentId,
        status: "DEPLOYED",
        workerId: { not: null },
        createdAt: { lte: current.createdAt },
      },
      orderBy: { createdAt: "desc" },
      take: MAX_CHOICES * 2,
      select: { version: true, workerId: true },
    });
    const withTask = new Set(
      (
        await prisma.backgroundWorkerTask.findMany({
          where: {
            // oxlint-disable-next-line trigger-prisma/no-unbounded-list-filter -- At most MAX_CHOICES * 2 (100) worker ids, from the take above.
            workerId: { in: deployments.flatMap((d) => (d.workerId ? [d.workerId] : [])) },
            slug: task,
          },
          select: { workerId: true },
        })
      ).map((row) => row.workerId)
    );
    versions = deployments.flatMap((d) =>
      d.workerId && withTask.has(d.workerId) ? [d.version] : []
    );

    if (current.workerId) {
      // On the (workerId, slug) unique index.
      const agent = await prisma.backgroundWorkerTask.findFirst({
        where: { workerId: current.workerId, slug: task },
        select: { triggerSource: true, config: true },
      });
      if (agent?.triggerSource === "AGENT") {
        const inCode = agentInCode(agent.config);
        if (inCode.type === "versionSkew") choices.versionSkew = inCode.versionSkew;
        else if (inCode.type === "not-reported") choices.versionSkew = null;
      }
    }
  } else {
    // On the (environmentId, createdAt) index.
    const rows = await prisma.workerDeployment.findMany({
      where: { environmentId, status: "DEPLOYED", createdAt: { lte: current.createdAt } },
      orderBy: { createdAt: "desc" },
      take: MAX_CHOICES * 2,
      select: { version: true },
    });
    versions = rows.map((row) => row.version);
  }
  choices.versions = versions
    .filter((version) => compareDeploymentVersions(version, currentVersion) <= 0)
    .sort((a, b) => compareDeploymentVersions(b, a))
    .slice(0, MAX_CHOICES);

  return choices;
}
