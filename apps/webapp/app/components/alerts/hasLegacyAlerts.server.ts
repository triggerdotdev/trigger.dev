import { prisma } from "~/db.server";
import { LEGACY_ALERT_TYPE_MIGRATION, LEGACY_ALERT_TYPES } from "./legacyAlertChannels";

export async function hasLegacyAlerts(
  projectId: string,
  db: Pick<typeof prisma, "projectAlertChannel"> = prisma
): Promise<{ hasLegacyAlerts: boolean; hasMigratableLegacyAlerts: boolean }> {
  const channels = await db.projectAlertChannel.findMany({
    where: { projectId, alertTypes: { hasSome: [...LEGACY_ALERT_TYPES] } },
    select: { alertTypes: true },
  });
  return {
    hasLegacyAlerts: channels.length > 0,
    hasMigratableLegacyAlerts: channels.some((channel) =>
      channel.alertTypes.some(
        (type) =>
          type in LEGACY_ALERT_TYPE_MIGRATION &&
          LEGACY_ALERT_TYPE_MIGRATION[type as keyof typeof LEGACY_ALERT_TYPE_MIGRATION].kind ===
            "replace"
      )
    ),
  };
}
