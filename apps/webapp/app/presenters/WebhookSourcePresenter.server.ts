import { type User, type Webhook } from "@trigger.dev/database";
import { type PrismaClient, prisma } from "~/db.server";
import { type Organization } from "~/models/organization.server";
import { type Project } from "~/models/project.server";
import { RunListPresenter } from "./RunListPresenter.server";
import { organizationPath, projectPath } from "~/utils/pathBuilder";
import { type Direction } from "~/components/runs/RunStatuses";

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
    getDeliveryRuns = false,
  }: {
    userId: User["id"];
    projectSlug: Project["slug"];
    organizationSlug: Organization["slug"];
    webhookId: Webhook["id"];
    direction?: Direction;
    cursor?: string;
    getDeliveryRuns?: boolean;
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
        httpEndpoint: {
          select: {
            key: true,
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
    const jobSlug = getDeliveryRuns
      ? getDeliveryJobSlug(webhook.key)
      : getRegistrationJobSlug(webhook.key);

    const runList = await runListPresenter.call({
      userId,
      jobSlug,
      organizationSlug,
      projectSlug,
      direction,
      cursor,
    });

    const orgRootPath = organizationPath({ slug: organizationSlug });
    const projectRootPath = projectPath({ slug: organizationSlug }, { slug: projectSlug });

    return {
      trigger: {
        id: webhook.id,
        key: webhook.key,
        active: webhook.active,
        integration: webhook.integration,
        integrationLink: `${orgRootPath}/integrations/${webhook.integration.slug}`,
        httpEndpoint: webhook.httpEndpoint,
        httpEndpointLink: `${projectRootPath}/http-endpoints/${webhook.httpEndpoint.key}`,
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
