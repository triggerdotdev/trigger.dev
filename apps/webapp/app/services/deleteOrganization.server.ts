import { DateFormatter } from "@internationalized/date";
import { type PrismaClient } from "@trigger.dev/database";
import { prisma } from "~/db.server";
import { featuresForRequest } from "~/features.server";
import { BillingService } from "./billing.v2.server";
import { DeleteProjectService } from "./deleteProject.server";

export class DeleteOrganizationService {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  public async call({
    organizationSlug,
    userId,
    request,
  }: {
    organizationSlug: string;
    userId: string;
    request: Request;
  }) {
    const organization = await this.#prismaClient.organization.findFirst({
      include: {
        projects: true,
        members: true,
      },
      where: {
        slug: organizationSlug,
        members: { some: { userId: userId } },
      },
    });

    if (!organization) {
      throw new Error("Organization not found");
    }

    if (organization.deletedAt) {
      throw new Error("Organization already deleted");
    }

    //check if they have an active subscription
    const { isManagedCloud } = featuresForRequest(request);
    const billingPresenter = new BillingService(isManagedCloud);
    const currentPlan = await billingPresenter.currentPlan(organization.id);

    if (currentPlan && currentPlan.subscription && currentPlan.subscription.isPaying) {
      //they've cancelled and that date hasn't passed yet
      if (
        currentPlan.subscription.canceledAt &&
        new Date(currentPlan.subscription.canceledAt) > new Date()
      ) {
        //a dateformatter that produces results like "Jan 1 2024"
        const dateFormatter = new DateFormatter("en-us", {
          year: "numeric",
          month: "short",
          day: "numeric",
        });
        throw new Error(
          `This Organization has a canceled subscription. You can delete it when the cancelation date (${dateFormatter.format(
            new Date(currentPlan.subscription.canceledAt)
          )}) is in the past.`
        );
      }

      throw new Error("You can't delete an Organization that has an active subscription");
    }

    // loop through the projects and delete them
    const projectDeleteService = new DeleteProjectService();
    for (const project of organization.projects) {
      await projectDeleteService.call({ projectId: project.id, userId });
    }

    //set all the integrations to disabled
    await this.#prismaClient.integrationConnection.updateMany({
      where: {
        organizationId: organization.id,
      },
      data: {
        enabled: false,
      },
    });

    //mark the organization as deleted
    await this.#prismaClient.organization.update({
      where: {
        id: organization.id,
      },
      data: {
        runsEnabled: false,
        deletedAt: new Date(),
      },
    });
  }
}
