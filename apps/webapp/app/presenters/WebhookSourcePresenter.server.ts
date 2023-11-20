import { User, Webhook } from "@trigger.dev/database";
import { PrismaClient, prisma } from "~/db.server";
import { Organization } from "~/models/organization.server";
import { Project } from "~/models/project.server";
import { Direction, RunListPresenter } from "./RunListPresenter.server";

export class WebhookSourcePresenter {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  public async call({
    userId,
    projectSlug,
    organizationSlug,
    webhookId,
    direction = "forward",
    cursor,
    getDeliveryRuns = false
  }: {
    userId: User["id"];
    projectSlug: Project["slug"];
    organizationSlug: Organization["slug"];
    webhookId: Webhook["id"];
    direction?: Direction;
    cursor?: string;
    getDeliveryRuns?: boolean
  }) {
    const webhook = await this.#prismaClient.webhook.findUnique({
      select: {
        id: true,
        key: true,
        active: true,
        integration: {
          select: {
            id: true,
            title: true,
            slug: true,
            definitionId: true,
            setupStatus: true,
            definition: {
              select: {
                icon: true,
              },
            },
          },
        },
        createdAt: true,
        updatedAt: true,
        params: true,
      },
      where: {
        id: webhookId,
      },
    });

    if (!webhook) {
      throw new Error("Webhook source not found");
    }

    const runListPresenter = new RunListPresenter(this.#prismaClient);
    const jobSlug = getDeliveryRuns ? getDeliveryJobSlug(webhook.key) : getRegistrationJobSlug(webhook.key);

    const runList = await runListPresenter.call({
      userId,
      jobSlug,
      organizationSlug,
      projectSlug,
      direction,
      cursor,
    });

    return {
      trigger: {
        id: webhook.id,
        active: webhook.active,
        integration: webhook.integration,
        createdAt: webhook.createdAt,
        updatedAt: webhook.updatedAt,
        params: webhook.params,
        runList,
      },
    };
  }
}

const getRegistrationJobSlug = (key: string) => `webhook.register.${key}`;

const getDeliveryJobSlug = (key: string) => `webhook.deliver.${key}`;
