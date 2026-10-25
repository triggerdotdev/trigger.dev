import { tryCatch } from "@trigger.dev/core/v3";
import type { PrismaClient } from "@trigger.dev/database";
import { prisma } from "~/db.server";
import { DeleteProjectService } from "./deleteProject.server";
import { cancelSubscription, getCurrentPlanOrThrow } from "./platform.v3.server";
import { controlPlaneResolver } from "~/v3/runOpsMigration/controlPlaneResolver.server";
import { commonWorker } from "~/v3/commonWorker.server";
import { logger } from "./logger.server";

export class DeleteOrganizationService {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  public async call({
    organizationSlug,
    userId,
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

    await this.#cancelSubscription(organization.id);

    // loop through the projects and delete them
    const projectDeleteService = new DeleteProjectService();
    for (const project of organization.projects) {
      await projectDeleteService.call({ projectId: project.id, userId });
    }

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

    // runsEnabled + the org's projects (project.deletedAt) changed; drop all cached env rows.
    controlPlaneResolver.invalidateOrganization(organization.id);

    // Soft-delete the org's dashboard agent chats; retention purges them later. Enqueued,
    // not inline: the agent store is a separate database in cloud.
    // Best-effort: a failed enqueue must not fail org deletion (the org is already deleted).
    try {
      await commonWorker.enqueue({
        id: `dashboardAgent.purgeOrganization:${organization.id}`,
        job: "dashboardAgent.purgeOrganization",
        payload: { organizationId: organization.id },
      });
    } catch (error) {
      logger.warn("Failed to enqueue dashboard agent purge for deleted organization", {
        organizationId: organization.id,
        error,
      });
    }
  }

  async #cancelSubscription(organizationId: string) {
    let plan: Awaited<ReturnType<typeof getCurrentPlanOrThrow>>;
    try {
      plan = await getCurrentPlanOrThrow(organizationId);
    } catch (error) {
      logger.error("Failed to load plan before deleting organization", { organizationId, error });
      throw new Error("Couldn't verify billing state, try again");
    }

    if (!plan) return;

    const [error, result] = await tryCatch(cancelSubscription(organizationId));
    if (error || !result?.success) {
      logger.error("Failed to cancel subscription before deleting organization", {
        organizationId,
        error,
        result,
      });
      throw new Error("Couldn't cancel the subscription, try again");
    }
  }
}
