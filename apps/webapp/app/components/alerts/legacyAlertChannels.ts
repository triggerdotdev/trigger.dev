import type {
  ProjectAlertChannelType,
  ProjectAlertType,
  RuntimeEnvironmentType,
} from "@trigger.dev/database";

export type LegacyAlertChannelRow = {
  id: string;
  name: string;
  channelKind: string;
  enabled: boolean;
  alertTypes: ProjectAlertType[];
  alertTypeLabels: string[];
  environmentNames: string[];
  canWrite?: boolean;
  canDelete?: boolean;
};

export const LEGACY_ALERT_TYPES = new Set<ProjectAlertType>([
  "TASK_RUN",
  "TASK_RUN_ATTEMPT",
  "DEPLOYMENT_FAILURE",
  "DEPLOYMENT_SUCCESS",
]);

export type LegacyAlertType =
  | "TASK_RUN"
  | "TASK_RUN_ATTEMPT"
  | "DEPLOYMENT_FAILURE"
  | "DEPLOYMENT_SUCCESS";

const LEGACY_ALERT_TYPE_LABEL: Record<LegacyAlertType, string> = {
  TASK_RUN: "Task run failure",
  TASK_RUN_ATTEMPT: "Task attempt failure",
  DEPLOYMENT_FAILURE: "Deployment failure",
  DEPLOYMENT_SUCCESS: "Deployment success",
};

export type LegacyAlertMigration =
  | { kind: "replace"; capabilityKey: "runs.failed" }
  | { kind: "coming-soon" };

export const LEGACY_ALERT_TYPE_MIGRATION: Record<LegacyAlertType, LegacyAlertMigration> = {
  TASK_RUN: { kind: "replace", capabilityKey: "runs.failed" },
  TASK_RUN_ATTEMPT: { kind: "coming-soon" },
  DEPLOYMENT_FAILURE: { kind: "coming-soon" },
  DEPLOYMENT_SUCCESS: { kind: "coming-soon" },
};

export type LegacySubscriptionRow = {
  channelId: string;
  channelName: string;
  channelKind: string;
  alertType: LegacyAlertType;
  alertTypeLabel: string;
  environmentNames: string[];
  enabled: boolean;
  migration: LegacyAlertMigration;
  canWrite?: boolean;
  canDelete?: boolean;
};

export function legacySubscriptions(channels: LegacyAlertChannelRow[]): LegacySubscriptionRow[] {
  const rows = channels.flatMap((channel) =>
    channel.alertTypes.flatMap((alertType) =>
      alertType in LEGACY_ALERT_TYPE_MIGRATION
        ? [
            {
              channelId: channel.id,
              channelName: channel.name,
              channelKind: channel.channelKind,
              alertType: alertType as LegacyAlertType,
              alertTypeLabel: LEGACY_ALERT_TYPE_LABEL[alertType as LegacyAlertType],
              environmentNames: channel.environmentNames,
              enabled: channel.enabled,
              migration: LEGACY_ALERT_TYPE_MIGRATION[alertType as LegacyAlertType],
              canWrite: channel.canWrite,
              canDelete: channel.canDelete,
            },
          ]
        : []
    )
  );
  const rank = (row: LegacySubscriptionRow) => (row.migration.kind === "replace" ? 0 : 1);
  return rows.sort((a, b) => rank(a) - rank(b) || a.channelName.localeCompare(b.channelName));
}

const CHANNEL_KIND_LABEL: Record<ProjectAlertChannelType, string> = {
  EMAIL: "Email",
  SLACK: "Slack",
  WEBHOOK: "Webhook",
};

export function isLegacyAlertChannel(alertTypes: ProjectAlertType[]): boolean {
  return alertTypes.some((type) => LEGACY_ALERT_TYPES.has(type));
}

/** The channels this pass shows as "Legacy" rows -- a channel with a legacy AND a migrated
 * type (e.g. TASK_RUN + ERROR_GROUP together) still shows, but only its legacy types are
 * listed, since the ERROR_GROUP half already has a modern equivalent. */
export function toLegacyAlertChannelRows(
  channels: {
    id: string;
    name: string;
    type: ProjectAlertChannelType;
    enabled: boolean;
    alertTypes: ProjectAlertType[];
    environmentTypes: RuntimeEnvironmentType[];
  }[],
  alertTypeTitle: (type: ProjectAlertType) => string
): LegacyAlertChannelRow[] {
  return channels
    .filter((channel) => isLegacyAlertChannel(channel.alertTypes))
    .map((channel) => ({
      id: channel.id,
      name: channel.name,
      channelKind: CHANNEL_KIND_LABEL[channel.type],
      enabled: channel.enabled,
      alertTypes: channel.alertTypes.filter((type) => LEGACY_ALERT_TYPES.has(type)),
      alertTypeLabels: channel.alertTypes
        .filter((type) => LEGACY_ALERT_TYPES.has(type))
        .map(alertTypeTitle),
      environmentNames: channel.environmentTypes.map((type) => type.toLowerCase()),
    }));
}

export const LEGACY_ALERTS_ROUTE_ID =
  "routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.alerts_.legacy";

export function replacedMessage(count: number, skipped = 0) {
  const created = `Created ${count} ${count === 1 ? "alert" : "alerts"}`;
  return skipped > 0 ? `${created} (skipped ${skipped}: scope not found)` : created;
}

export function afterReplace(
  legacyRemaining: boolean | undefined,
  alertsPath: string,
  navigate: (path: string) => void,
  revalidate: () => void
) {
  if (legacyRemaining === false) navigate(alertsPath);
  else revalidate();
}
