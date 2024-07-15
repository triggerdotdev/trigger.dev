import { type OrganizationIntegration } from "@trigger.dev/database";
import { BaseService } from "./baseService.server";
import { WebClient } from "@slack/web-api";
import { env } from "~/env.server";
import { $transaction } from "~/db.server";
import { getSecretStore } from "~/services/secrets/secretStore.server";
import { generateFriendlyId } from "../friendlyIdentifiers";
import { OrgIntegrationRepository } from "~/models/orgIntegration.server";

export class CreateOrgIntegrationService extends BaseService {
  public async call(
    userId: string,
    orgId: string,
    serviceName: string,
    code: string
  ): Promise<OrganizationIntegration | undefined> {
    // Get the org
    const org = await this._prisma.organization.findUnique({
      where: {
        id: orgId,
        members: {
          some: {
            userId,
          },
        },
      },
    });

    if (!org) {
      throw new Error("Organization not found");
    }

    return OrgIntegrationRepository.createOrgIntegration(serviceName, code, org);
  }
}
