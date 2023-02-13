import type { PrismaClient } from "~/db.server";
import { prisma } from "~/db.server";
import { getRuntimeEnvironment } from "~/models/runtimeEnvironment.server";
import { WorkflowsPresenter } from "./workflowsPresenter.server";

export class OrganizationTemplatePresenter {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  async data(templateId: string, environmentSlug: string) {
    const organizationTemplate =
      await this.#prismaClient.organizationTemplate.findUnique({
        where: {
          id: templateId,
        },
        include: {
          template: true,
        },
      });

    if (!organizationTemplate) {
      throw new Error("Organization template not found");
    }

    const runtimeEnvironment = await getRuntimeEnvironment({
      organizationId: organizationTemplate.organizationId,
      slug: environmentSlug,
    });

    if (!runtimeEnvironment) {
      throw new Error("Runtime environment not found");
    }

    const workflowsPresenter = new WorkflowsPresenter(this.#prismaClient);

    const workflows = await workflowsPresenter.data(
      {
        organizationId: organizationTemplate.organizationId,
        slug: {
          in: organizationTemplate.template.workflowIds,
        },
      },
      runtimeEnvironment.id
    );

    return {
      organizationTemplate,
      apiKey: runtimeEnvironment.apiKey,
      workflows,
    };
  }
}
