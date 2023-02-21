import invariant from "tiny-invariant";
import type { PrismaClient } from "~/db.server";
import { prisma } from "~/db.server";
import { getRuntimeEnvironment } from "~/models/runtimeEnvironment.server";
import { WorkflowsPresenter } from "../presenters/workflowsPresenter.server";

export type WorkflowListItem = Awaited<
  ReturnType<WorkflowListPresenter["data"]>
>[number];

export class WorkflowListPresenter {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  async data(organizationSlug: string, environmentSlug: string) {
    const organization = await this.#prismaClient.organization.findUnique({
      where: { slug: organizationSlug },
      select: { id: true },
    });
    invariant(organization, "Organization not found");

    const runtimeEnvironment = await getRuntimeEnvironment({
      organizationId: organization.id,
      slug: environmentSlug,
    });
    invariant(runtimeEnvironment, "Runtime environment not found");

    const workflowsPresenter = new WorkflowsPresenter();

    return workflowsPresenter.data(
      { organization: { slug: organizationSlug }, isArchived: false },
      runtimeEnvironment.id
    );
  }
}
