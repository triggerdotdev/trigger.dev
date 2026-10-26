import { getCapability, notifierRefKey, type NotifierRef } from "@internal/alert-contracts";
import {
  boundedIn,
  type ProjectAlertType,
  type RuntimeEnvironmentType,
} from "@trigger.dev/database";
import {
  LEGACY_ALERT_TYPE_MIGRATION,
  type LegacyAlertType,
} from "~/components/alerts/legacyAlertChannels";
import { prisma as defaultPrisma, type PrismaClientOrTransaction } from "~/db.server";
import { logger } from "~/services/logger.server";
import { ServiceValidationError } from "../common.server";
import { deleteAlertAndUnschedule, type AlertLifecycleDeps } from "./alertLifecycle.server";
import type { AlertDraftScope } from "./alertDraft";
import { createAlertFromDraft } from "./createAlertFromDraft.server";
import type { Alert } from "./storage/alertStore.server";
import { availableAlertChannelWhere } from "./validateNotifierChannels.server";

export type ReplaceLegacySubscriptionParams = {
  projectId: string;
  channelId: string;
  alertType: string;
  userId: string;
  environmentIds: string[];
  value?: number;
  windowSec?: number;
  expiresAt?: Date;
  scope?: AlertDraftScope;
  notifiers?: NotifierRef[];
  authorize?: (environmentTypes: RuntimeEnvironmentType[]) => void;
};

export type ReplaceLegacySubscriptionResult = {
  replaced: boolean;
  alertIds: string[];
  skipped?: number;
};

export type ReplaceEnvironment = {
  id: string;
  type: RuntimeEnvironmentType;
  slug: string;
  branchName: string | null;
};

export function replaceableEnvironments(
  prisma: PrismaClientOrTransaction,
  projectId: string,
  environmentTypes: RuntimeEnvironmentType[],
  userId: string
): Promise<ReplaceEnvironment[]> {
  return prisma.runtimeEnvironment.findMany({
    where: {
      projectId,
      archivedAt: null,
      isBranchableEnvironment: false,
      OR: [
        { type: { in: boundedIn(environmentTypes.filter((type) => type !== "DEVELOPMENT")) } },
        ...(environmentTypes.includes("DEVELOPMENT")
          ? [{ type: "DEVELOPMENT" as const, parentEnvironmentId: null, orgMember: { userId } }]
          : []),
      ],
    },
    select: { id: true, type: true, slug: true, branchName: true },
    orderBy: { createdAt: "asc" },
  });
}

function uniqueNotifiers(notifiers: NotifierRef[]): NotifierRef[] {
  const seen = new Set<string>();
  return notifiers.filter((notifier) => {
    const key = notifierRefKey(notifier);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export class ReplaceLegacySubscriptionService {
  constructor(
    private readonly prisma: PrismaClientOrTransaction = defaultPrisma,
    private readonly db: PrismaClientOrTransaction = defaultPrisma,
    private readonly createAlert: typeof createAlertFromDraft = createAlertFromDraft,
    private readonly lifecycleDeps?: AlertLifecycleDeps
  ) {}

  public async call(
    params: ReplaceLegacySubscriptionParams
  ): Promise<ReplaceLegacySubscriptionResult> {
    const migration = LEGACY_ALERT_TYPE_MIGRATION[params.alertType as LegacyAlertType];
    const capability =
      migration?.kind === "replace" ? getCapability(migration.capabilityKey) : undefined;
    if (!capability) {
      throw new ServiceValidationError("This alert type can't be replaced yet");
    }
    const alertType = params.alertType as ProjectAlertType;

    const channel = await this.prisma.projectAlertChannel.findFirst({
      where: { id: params.channelId, projectId: params.projectId },
      select: {
        id: true,
        name: true,
        enabled: true,
        alertTypes: true,
        environmentTypes: true,
        project: { select: { organizationId: true } },
      },
    });
    if (!channel) {
      throw new ServiceValidationError("Alert channel not found");
    }
    params.authorize?.(channel.environmentTypes);
    if (!channel.alertTypes.includes(alertType)) {
      return { replaced: false, alertIds: [] };
    }
    if (!channel.enabled) {
      throw new ServiceValidationError("Enable the channel before replacing it");
    }

    const covered = await replaceableEnvironments(
      this.prisma,
      params.projectId,
      channel.environmentTypes,
      params.userId
    );
    if (covered.length === 0) {
      throw new ServiceValidationError("No environments to create alerts in");
    }
    const selected = new Set(params.environmentIds);
    if (selected.size === 0) {
      throw new ServiceValidationError("Pick at least one environment");
    }
    const picked = covered.filter((environment) => selected.has(environment.id));
    if (picked.length !== selected.size) {
      throw new ServiceValidationError("Unknown environment");
    }
    const scope = params.scope ?? { type: "all" };
    const scopeLabel = scope.type === "task" ? scope.taskIdentifier : "all runs";
    const environments: ReplaceEnvironment[] = [];
    for (const environment of picked) {
      if (await this.scopeExists(scope, environment.id)) environments.push(environment);
    }
    if (environments.length === 0) {
      throw new ServiceValidationError("Scope not found in the selected environments");
    }

    const notifiers = uniqueNotifiers(
      params.notifiers ?? [{ type: "channel", channelId: channel.id }]
    );
    const channelIds = notifiers.flatMap((notifier) =>
      notifier.type === "channel" ? [notifier.channelId] : []
    );
    for (const environment of environments) {
      const valid = new Set(
        (
          await this.prisma.projectAlertChannel.findMany({
            where: {
              id: { in: boundedIn(channelIds) },
              ...availableAlertChannelWhere({
                projectId: params.projectId,
                environmentType: environment.type,
              }),
            },
            select: { id: true },
          })
        ).map((row) => row.id)
      );
      if (channelIds.some((id) => !valid.has(id))) {
        throw new ServiceValidationError(
          `A selected notifier channel isn't available in ${environment.slug}`
        );
      }
    }

    const created: Alert[] = [];
    try {
      for (const environment of environments) {
        created.push(
          await this.createAlert(
            this.db,
            {
              organizationId: channel.project.organizationId,
              projectId: params.projectId,
              environmentId: environment.id,
              capabilityKey: capability.key,
              scope,
              condition: {
                kind: "threshold",
                operator: ">",
                value: params.value ?? 0,
                windowSec: params.windowSec ?? capability.minCadenceSec ?? 600,
              },
              expiresAt: params.expiresAt,
              notifiers,
              createdBy: params.userId,
              name: `${capability.title} above ${params.value ?? 0} on ${scopeLabel}`,
            },
            this.lifecycleDeps
          )
        );
      }
    } catch (error) {
      await this.rollBack(created);
      throw error;
    }

    const claimed = await this.prisma.projectAlertChannel.updateMany({
      where: {
        id: channel.id,
        alertTypes: { equals: channel.alertTypes },
        environmentTypes: { equals: channel.environmentTypes },
      },
      data: { alertTypes: channel.alertTypes.filter((type) => type !== alertType) },
    });
    if (claimed.count === 0) {
      await this.rollBack(created);
      return { replaced: false, alertIds: [] };
    }

    return {
      replaced: true,
      alertIds: created.map((alert) => alert.id),
      skipped: picked.length - environments.length,
    };
  }

  private async scopeExists(scope: AlertDraftScope, environmentId: string) {
    if (scope.type !== "task") return scope.type === "all";
    const task = await this.prisma.backgroundWorkerTask.findFirst({
      where: { runtimeEnvironmentId: environmentId, slug: scope.taskIdentifier },
      select: { id: true },
    });
    return Boolean(task);
  }

  private async rollBack(created: Alert[]) {
    for (const alert of created) {
      try {
        await deleteAlertAndUnschedule(
          this.db,
          { id: alert.id, projectId: alert.projectId, environmentId: alert.environmentId },
          this.lifecycleDeps
        );
      } catch (deleteError) {
        logger.error("Failed to roll back replacement alert", {
          alertId: alert.id,
          error: deleteError,
        });
      }
    }
  }
}
