import type { DisplayProperties } from "internal-integrations";
import { github } from "internal-integrations";
import invariant from "tiny-invariant";
import { triggerLabel } from "~/components/triggers/triggerLabel";
import type { PrismaClient } from "~/db.server";
import { prisma } from "~/db.server";
import { getIntegration } from "~/utils/integrations";
import { getIntegrations } from "./integrations.server";
import type { ExternalSource, Workflow } from "./workflow.server";

export type WorkflowListItem = Awaited<
  ReturnType<WorkflowListPresenter["data"]>
>[number];

export class WorkflowListPresenter {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  async data(organizationSlug: string) {
    const workflows = await getWorkflows(this.#prismaClient, organizationSlug);
    const integrations = getIntegrations(true);

    return workflows.map((workflow) => {
      const lastRun =
        workflow.runs[0] === undefined
          ? undefined
          : {
              finishedAt: workflow.runs[0].finishedAt,
              status: workflow.runs[0].status,
            };

      return {
        id: workflow.id,
        title: workflow.title,
        slug: workflow.slug,
        status: workflow.status,
        trigger: triggerProperties(
          workflow,
          workflow.externalSource ?? undefined
        ),
        integrations: {
          source: workflow.service
            ? getIntegration(integrations, workflow.service)
            : undefined,
          services: workflow.externalServices.map((service) =>
            getIntegration(integrations, service.service)
          ),
        },
        lastRun,
      };
    });
  }
}

function getWorkflows(prismaClient: PrismaClient, organizationSlug: string) {
  return prismaClient.workflow.findMany({
    where: { organization: { slug: organizationSlug } },
    include: {
      externalServices: {
        select: {
          service: true,
        },
      },
      externalSource: {
        select: {
          service: true,
          source: true,
        },
      },
      runs: {
        select: {
          finishedAt: true,
          status: true,
        },
        take: 1,
        orderBy: { finishedAt: { sort: "desc", nulls: "last" } },
      },
    },
  });
}

function triggerProperties(
  workflow: Pick<Workflow, "type" | "eventNames">,
  externalSource?: Pick<ExternalSource, "service" | "source">
): {
  type: Workflow["type"];
  typeTitle: string;
  title: string;
  properties?: DisplayProperties["properties"];
} {
  switch (workflow.type) {
    case "WEBHOOK": {
      invariant(externalSource, "External source is required for webhook");

      let displayProperties: DisplayProperties;
      switch (externalSource.service) {
        case "github":
          displayProperties = github.webhooks.displayProperties(
            externalSource.source
          );
          break;
        default:
          throw new Error(`Unsupported service ${externalSource.service}`);
      }

      return {
        type: workflow.type,
        typeTitle: "Webhook",
        title: displayProperties.title,
        properties: displayProperties.properties,
      };
    }
    case "CUSTOM_EVENT":
      return {
        type: workflow.type,
        typeTitle: "Custom event",
        title: `on: ${workflow.eventNames.join(", ")}`,
      };
    default: {
      return {
        type: workflow.type,
        typeTitle: triggerLabel(workflow.type),
        title: workflow.type,
      };
    }
  }
}
