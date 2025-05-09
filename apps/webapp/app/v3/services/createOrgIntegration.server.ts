import { OrganizationIntegration } from "@trigger.dev/database";
import { BaseService } from "./baseService.server";
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
