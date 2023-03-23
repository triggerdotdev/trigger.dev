import invariant from "tiny-invariant";
import type { PrismaClient } from "~/db.server";
import { prisma } from "~/db.server";
import { WorkflowsPresenter } from "../presenters/workflowsPresenter.server";
import { TemplateListPresenter } from "./templateListPresenter.server";

export type WorkflowListItem = Awaited<
  ReturnType<WorkflowListPresenter["data"]>
>["workflows"][number];

export class WorkflowListPresenter {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  async data(organizationSlug: string) {
    const organization = await this.#prismaClient.organization.findUnique({
      where: { slug: organizationSlug },
      select: { id: true },
    });
    invariant(organization, "Organization not found");

    const templatesPresenter = new TemplateListPresenter();

    const workflowsPresenter = new WorkflowsPresenter();

    const workflows = await workflowsPresenter.data({
      organization: { slug: organizationSlug },
      isArchived: false,
    });
    const { templates } = await templatesPresenter.data();

    return {
      workflows,
      templates,
    };
  }
}
