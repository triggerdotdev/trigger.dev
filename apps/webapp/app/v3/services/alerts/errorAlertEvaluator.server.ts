import { type ActiveErrorsSinceQueryResult, type ClickHouse } from "@internal/clickhouse";
import {
  type ErrorGroupState,
  type PrismaClientOrTransaction,
  type ProjectAlertChannel,
  type RuntimeEnvironmentType,
} from "@trigger.dev/database";
import { $replica, prisma } from "~/db.server";
import { ErrorAlertConfig } from "~/models/projectAlert.server";
import { clickhouseClient } from "~/services/clickhouseInstance.server";
import { logger } from "~/services/logger.server";
import { alertsWorker } from "~/v3/alertsWorker.server";

type ErrorClassification = "new_issue" | "regression" | "unignored";

interface AlertableError {
  classification: ErrorClassification;
  error: ActiveErrorsSinceQueryResult;
  environmentSlug: string;
  environmentName: string;
}

interface ResolvedEnvironment {
  id: string;
  slug: string;
  type: RuntimeEnvironmentType;
  displayName: string;
}

const DEFAULT_INTERVAL_MS = 300_000;

/**
 * For a project evalutes whether to send error alerts
 *
 * Alerts are sent if an error is
 * 1. A new issue
 * 2. A regression (was resolved and now back)
 * 3. Unignored (was ignored and is no longer)
 *
 * Unignored happens in 3 situations
 * 1. It was ignored with a future date, and that's now in the past
 * 2. It was ignored until reaching an error rate (e.g. 10/minute) and that has been exceeded
 * 3. It was ignored until reaching a total occurrence count (e.g. 1,000) and that has been exceeded
 */
export class ErrorAlertEvaluator {
  constructor(
    protected readonly _prisma: PrismaClientOrTransaction = prisma,
    protected readonly _replica: PrismaClientOrTransaction = $replica,
    protected readonly _clickhouse: ClickHouse = clickhouseClient
  ) {}

  async evaluate(projectId: string, scheduledAt: number): Promise<void> {
    const nextScheduledAt = Date.now();

    const channels = await this.resolveChannels(projectId);
    if (channels.length === 0) {
      logger.info("[ErrorAlertEvaluator] No active ERROR_GROUP channels, self-terminating", {
        projectId,
      });
      return;
    }

    const minIntervalMs = this.computeMinInterval(channels);
    const windowMs = nextScheduledAt - scheduledAt;

    if (windowMs > minIntervalMs * 2) {
      logger.info("[ErrorAlertEvaluator] Large evaluation window (gap detected)", {
        projectId,
        scheduledAt,
        nextScheduledAt,
        windowMs,
        minIntervalMs,
      });
    }

    const allEnvTypes = this.collectEnvironmentTypes(channels);

    try {
      const [project, environments] = await Promise.all([
        this._replica.project.findFirst({
          where: { id: projectId },
          select: { organizationId: true },
        }),
        this.resolveEnvironments(projectId, allEnvTypes),
      ]);

      if (!project) {
        logger.error("[ErrorAlertEvaluator] Project not found", { projectId });
        return;
      }

      if (environments.length === 0) {
        return;
      }

      const envIds = environments.map((e) => e.id);
      const envMap = new Map(environments.map((e) => [e.id, e]));
      const channelsByEnvId = this.buildChannelsByEnvId(channels, environments);

      const activeErrors = await this.getActiveErrors(
        project.organizationId,
        projectId,
        envIds,
        scheduledAt
      );

      if (activeErrors.length === 0) {
        return;
      }

      const states = await this.getErrorGroupStates(activeErrors);
      const stateMap = this.buildStateMap(states);

      const occurrenceCounts = await this.getOccurrenceCountsSince(
        project.organizationId,
        projectId,
        envIds,
        scheduledAt
      );
      const occurrenceMap = this.buildOccurrenceMap(occurrenceCounts);

      const alertableErrors: AlertableError[] = [];

      for (const error of activeErrors) {
        const key = `${error.environment_id}:${error.task_identifier}:${error.error_fingerprint}`;
        const state = stateMap.get(key);
        const env = envMap.get(error.environment_id);
        const firstSeenMs = Number(error.first_seen);

        const classification = this.classifyError(error, state, firstSeenMs, scheduledAt, {
          occurrencesSince: occurrenceMap.get(key) ?? 0,
          windowMs,
          totalOccurrenceCount: error.occurrence_count,
        });

        if (classification) {
          alertableErrors.push({
            classification,
            error,
            environmentSlug: env?.slug ?? "",
            environmentName: env?.displayName ?? error.environment_id,
          });
        }
      }

      for (const alertable of alertableErrors) {
        const envChannels = channelsByEnvId.get(alertable.error.environment_id) ?? [];
        for (const channel of envChannels) {
          await alertsWorker.enqueue({
            id: `deliverErrorGroupAlert:${channel.id}:${alertable.error.error_fingerprint}:${scheduledAt}`,
            job: "v3.deliverErrorGroupAlert",
            payload: {
              channelId: channel.id,
              projectId,
              classification: alertable.classification,
              error: {
                fingerprint: alertable.error.error_fingerprint,
                environmentId: alertable.error.environment_id,
                environmentSlug: alertable.environmentSlug,
                environmentName: alertable.environmentName,
                taskIdentifier: alertable.error.task_identifier,
                errorType: alertable.error.error_type,
                errorMessage: alertable.error.error_message,
                sampleStackTrace: alertable.error.sample_stack_trace,
                firstSeen: alertable.error.first_seen,
                lastSeen: alertable.error.last_seen,
                occurrenceCount: alertable.error.occurrence_count,
              },
            },
          });
        }
      }

      const stateUpdates = alertableErrors.filter(
        (a) => a.classification === "regression" || a.classification === "unignored"
      );
      await this.updateErrorGroupStates(stateUpdates, stateMap);

      logger.info("[ErrorAlertEvaluator] Evaluation complete", {
        projectId,
        activeErrors: activeErrors.length,
        alertableErrors: alertableErrors.length,
        deliveryJobsEnqueued: alertableErrors.reduce(
          (sum, a) => sum + (channelsByEnvId.get(a.error.environment_id)?.length ?? 0),
          0
        ),
      });
    } catch (error) {
      logger.error("[ErrorAlertEvaluator] Evaluation failed, will retry on next cycle", {
        projectId,
        error,
      });
    } finally {
      await this.selfChain(projectId, nextScheduledAt, minIntervalMs);
    }
  }

  private classifyError(
    error: ActiveErrorsSinceQueryResult,
    state: ErrorGroupState | undefined,
    firstSeenMs: number,
    scheduledAt: number,
    thresholdContext: { occurrencesSince: number; windowMs: number; totalOccurrenceCount: number }
  ): ErrorClassification | null {
    if (!state) {
      return firstSeenMs > scheduledAt ? "new_issue" : null;
    }

    switch (state.status) {
      case "UNRESOLVED":
        return null;

      case "RESOLVED": {
        if (!state.resolvedAt) return null;
        const lastSeenMs = Number(error.last_seen);
        return lastSeenMs > state.resolvedAt.getTime() ? "regression" : null;
      }

      case "IGNORED":
        return this.isIgnoreBreached(state, thresholdContext) ? "unignored" : null;

      default:
        return null;
    }
  }

  private isIgnoreBreached(
    state: ErrorGroupState,
    context: { occurrencesSince: number; windowMs: number; totalOccurrenceCount: number }
  ): boolean {
    if (state.ignoredUntil && state.ignoredUntil.getTime() <= Date.now()) {
      return true;
    }

    if (
      state.ignoredUntilOccurrenceRate !== null &&
      state.ignoredUntilOccurrenceRate !== undefined
    ) {
      const windowMinutes = Math.max(context.windowMs / 60_000, 1);
      const rate = context.occurrencesSince / windowMinutes;
      if (rate > state.ignoredUntilOccurrenceRate) {
        return true;
      }
    }

    if (
      state.ignoredUntilTotalOccurrences != null &&
      state.ignoredAtOccurrenceCount != null
    ) {
      const occurrencesSinceIgnored =
        context.totalOccurrenceCount - Number(state.ignoredAtOccurrenceCount);
      if (occurrencesSinceIgnored >= state.ignoredUntilTotalOccurrences) {
        return true;
      }
    }

    return false;
  }

  private async resolveChannels(projectId: string): Promise<ProjectAlertChannel[]> {
    return this._replica.projectAlertChannel.findMany({
      where: {
        projectId,
        alertTypes: { has: "ERROR_GROUP" },
        enabled: true,
      },
    });
  }

  private computeMinInterval(channels: ProjectAlertChannel[]): number {
    let min = DEFAULT_INTERVAL_MS;
    for (const ch of channels) {
      const config = ErrorAlertConfig.safeParse(ch.errorAlertConfig);
      if (config.success) {
        min = Math.min(min, config.data.evaluationIntervalMs);
      }
    }
    return min;
  }

  private collectEnvironmentTypes(channels: ProjectAlertChannel[]): RuntimeEnvironmentType[] {
    const types = new Set<RuntimeEnvironmentType>();
    for (const ch of channels) {
      for (const t of ch.environmentTypes) {
        types.add(t);
      }
    }
    return Array.from(types);
  }

  private async resolveEnvironments(
    projectId: string,
    types: RuntimeEnvironmentType[]
  ): Promise<ResolvedEnvironment[]> {
    const envs = await this._replica.runtimeEnvironment.findMany({
      where: {
        projectId,
        type: { in: types },
      },
      select: {
        id: true,
        type: true,
        slug: true,
        branchName: true,
      },
    });

    return envs.map((e) => ({
      id: e.id,
      slug: e.slug,
      type: e.type,
      displayName: e.branchName ?? e.slug,
    }));
  }

  private buildChannelsByEnvId(
    channels: ProjectAlertChannel[],
    environments: ResolvedEnvironment[]
  ): Map<string, ProjectAlertChannel[]> {
    const result = new Map<string, ProjectAlertChannel[]>();
    for (const env of environments) {
      const matching = channels.filter((ch) => ch.environmentTypes.includes(env.type));
      if (matching.length > 0) {
        result.set(env.id, matching);
      }
    }
    return result;
  }

  private async getActiveErrors(
    organizationId: string,
    projectId: string,
    envIds: string[],
    scheduledAt: number
  ): Promise<ActiveErrorsSinceQueryResult[]> {
    const qb = this._clickhouse.errors.activeErrorsSinceQueryBuilder();
    qb.where("organization_id = {organizationId: String}", { organizationId });
    qb.where("project_id = {projectId: String}", { projectId });
    qb.where("environment_id IN {envIds: Array(String)}", { envIds });
    qb.groupBy("environment_id, task_identifier, error_fingerprint");
    qb.having("toInt64(last_seen) > {scheduledAt: Int64}", {
      scheduledAt,
    });

    const [err, results] = await qb.execute();
    if (err) {
      logger.error("[ErrorAlertEvaluator] Failed to query active errors", { error: err });
      return [];
    }
    return results ?? [];
  }

  private async getErrorGroupStates(
    activeErrors: ActiveErrorsSinceQueryResult[]
  ): Promise<ErrorGroupState[]> {
    if (activeErrors.length === 0) return [];

    return this._replica.errorGroupState.findMany({
      where: {
        OR: activeErrors.map((e) => ({
          environmentId: e.environment_id,
          taskIdentifier: e.task_identifier,
          errorFingerprint: e.error_fingerprint,
        })),
      },
    });
  }

  private buildStateMap(states: ErrorGroupState[]): Map<string, ErrorGroupState> {
    const map = new Map<string, ErrorGroupState>();
    for (const s of states) {
      map.set(`${s.environmentId}:${s.taskIdentifier}:${s.errorFingerprint}`, s);
    }
    return map;
  }

  private async getOccurrenceCountsSince(
    organizationId: string,
    projectId: string,
    envIds: string[],
    scheduledAt: number
  ): Promise<
    Array<{
      environment_id: string;
      task_identifier: string;
      error_fingerprint: string;
      occurrences_since: number;
    }>
  > {
    const qb = this._clickhouse.errors.occurrenceCountsSinceQueryBuilder();
    qb.where("organization_id = {organizationId: String}", { organizationId });
    qb.where("project_id = {projectId: String}", { projectId });
    qb.where("environment_id IN {envIds: Array(String)}", { envIds });
    qb.where("minute >= toStartOfMinute(fromUnixTimestamp64Milli({scheduledAt: Int64}))", {
      scheduledAt,
    });
    qb.groupBy("environment_id, task_identifier, error_fingerprint");

    const [err, results] = await qb.execute();
    if (err) {
      logger.error("[ErrorAlertEvaluator] Failed to query occurrence counts", { error: err });
      return [];
    }
    return results ?? [];
  }

  private buildOccurrenceMap(
    counts: Array<{
      environment_id: string;
      task_identifier: string;
      error_fingerprint: string;
      occurrences_since: number;
    }>
  ): Map<string, number> {
    const map = new Map<string, number>();
    for (const c of counts) {
      map.set(
        `${c.environment_id}:${c.task_identifier}:${c.error_fingerprint}`,
        c.occurrences_since
      );
    }
    return map;
  }

  private async updateErrorGroupStates(
    alertableErrors: AlertableError[],
    stateMap: Map<string, ErrorGroupState>
  ): Promise<void> {
    for (const alertable of alertableErrors) {
      const key = `${alertable.error.environment_id}:${alertable.error.task_identifier}:${alertable.error.error_fingerprint}`;
      const state = stateMap.get(key);
      if (!state) continue;

      await this._prisma.errorGroupState.update({
          where: { id: state.id },
          data: {
            status: "UNRESOLVED",
            ignoredUntil: null,
            ignoredUntilOccurrenceRate: null,
            ignoredUntilTotalOccurrences: null,
            ignoredAtOccurrenceCount: null,
            ignoredAt: null,
            ignoredReason: null,
            ignoredByUserId: null,
            resolvedAt: null,
            resolvedInVersion: null,
            resolvedBy: null,
          },
        });
    }
  }

  private async selfChain(
    projectId: string,
    nextScheduledAt: number,
    intervalMs: number
  ): Promise<void> {
    await alertsWorker.enqueue({
      id: `evaluateErrorAlerts:${projectId}`,
      job: "v3.evaluateErrorAlerts",
      payload: {
        projectId,
        scheduledAt: nextScheduledAt,
      },
      availableAt: new Date(nextScheduledAt + intervalMs),
    });
  }
}
