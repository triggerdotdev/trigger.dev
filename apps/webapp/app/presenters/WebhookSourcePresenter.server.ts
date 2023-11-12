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
  }: {
    userId: User["id"];
    projectSlug: Project["slug"];
    organizationSlug: Organization["slug"];
    webhookId: Webhook["id"];
    direction?: Direction;
    cursor?: string;
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
        environment: {
          select: {
            type: true,
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
    const registerJobSlug = getRegisterJobSlug(webhook.key);

    const runList = await runListPresenter.call({
      userId,
      jobSlug: registerJobSlug,
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
        environment: webhook.environment,
        createdAt: webhook.createdAt,
        updatedAt: webhook.updatedAt,
        params: webhook.params,
        registerJobSlug,
        runList,
      },
    };
  }
}

const getRegisterJobSlug = (key: string) => `webhook.register.${key}`;
