import type { ProjectAlertType, RuntimeEnvironmentType } from "@trigger.dev/database";
import {
  LEGACY_ALERT_TYPE_MIGRATION,
  type LegacyAlertType,
} from "~/components/alerts/legacyAlertChannels";
import { prisma as defaultPrisma, type PrismaClientOrTransaction } from "~/db.server";
import { ServiceValidationError } from "../common.server";

export type DeleteLegacySubscriptionParams = {
  projectId: string;
  channelId: string;
  alertType: string;
  authorize?: (environmentTypes: RuntimeEnvironmentType[]) => void;
};

export class DeleteLegacySubscriptionService {
  constructor(private readonly prisma: PrismaClientOrTransaction = defaultPrisma) {}

  public async call(params: DeleteLegacySubscriptionParams): Promise<{ deleted: boolean }> {
    if (!(params.alertType in LEGACY_ALERT_TYPE_MIGRATION)) {
      throw new ServiceValidationError("Not a legacy alert type");
    }
    const alertType = params.alertType as LegacyAlertType as ProjectAlertType;

    for (let attempt = 0; attempt < 5; attempt++) {
      const channel = await this.prisma.projectAlertChannel.findFirst({
        where: { id: params.channelId, projectId: params.projectId },
        select: { alertTypes: true, environmentTypes: true },
      });
      if (!channel) {
        throw new ServiceValidationError("Alert channel not found");
      }
      params.authorize?.(channel.environmentTypes);
      if (!channel.alertTypes.includes(alertType)) {
        return { deleted: false };
      }

      const updated = await this.prisma.projectAlertChannel.updateMany({
        where: {
          id: params.channelId,
          alertTypes: { equals: channel.alertTypes },
          environmentTypes: { equals: channel.environmentTypes },
        },
        data: { alertTypes: channel.alertTypes.filter((type) => type !== alertType) },
      });
      if (updated.count > 0) {
        return { deleted: true };
      }
    }
    throw new ServiceValidationError("Alert channel changed, try again");
  }
}
