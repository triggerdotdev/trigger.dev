import type { SchedulerSource, InternalSource } from ".prisma/client";
import {
  ScheduleSourceSchema,
  SlackInteractionSourceSchema,
} from "@trigger.dev/common-schemas";
import cronstrue from "cronstrue";
import type { DisplayProperties } from "@trigger.dev/integration-sdk";
import * as github from "@trigger.dev/github/internal";
import invariant from "tiny-invariant";
import { triggerLabel } from "~/components/triggers/triggerLabel";
import type { PrismaClient } from "~/db.server";
import { prisma } from "~/db.server";
import { getIntegrationMetadata, getIntegrations } from "./integrations.server";
import { getRuntimeEnvironment } from "./runtimeEnvironment.server";
import type { ExternalSource, Workflow } from "./workflow.server";

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

    const workflows = await getWorkflows(
      this.#prismaClient,
      organizationSlug,
      runtimeEnvironment.id
    );
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
          workflow.externalSource ?? undefined,
          workflow.schedulerSources[0] ?? undefined,
          workflow.internalSources[0] ?? undefined
        ),
        integrations: {
          source: workflow.service
            ? getIntegrationMetadata(integrations, workflow.service)
            : undefined,
          services: workflow.externalServices.map((service) =>
            getIntegrationMetadata(integrations, service.service)
          ),
        },
        lastRun,
      };
    });
  }
}

function getWorkflows(
  prismaClient: PrismaClient,
  organizationSlug: string,
  environmentId: string
) {
  return prismaClient.workflow.findMany({
    where: { organization: { slug: organizationSlug }, isArchived: false },
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
      schedulerSources: {
        select: {
          schedule: true,
        },
        where: {
          environmentId,
        },
        orderBy: { createdAt: "desc" },
        take: 1,
      },
      internalSources: {
        select: {
          source: true,
          type: true,
        },
        where: {
          environmentId,
        },
        orderBy: { createdAt: "desc" },
        take: 1,
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
    orderBy: [
      { disabledAt: { sort: "asc", nulls: "first" } },
      { title: "asc" },
    ],
  });
}

function triggerProperties(
  workflow: Pick<Workflow, "type" | "eventNames">,
  externalSource?: Pick<ExternalSource, "service" | "source">,
  schedulerSource?: Pick<SchedulerSource, "schedule">,
  internalSource?: Pick<InternalSource, "type" | "source">
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
          if (github.internalIntegration.webhooks) {
            displayProperties =
              github.internalIntegration.webhooks?.displayProperties(
                externalSource.source
              );
          } else {
            displayProperties = {
              title: externalSource.service,
            };
          }
          break;
        default:
          displayProperties = {
            title: externalSource.service,
          };
          break;
      }

      return {
        type: workflow.type,
        typeTitle: "Webhook",
        title: displayProperties.title,
        properties: displayProperties.properties,
      };
    }
    case "SCHEDULE": {
      if (!schedulerSource) {
        return {
          type: workflow.type,
          typeTitle: "Schedule",
          title: "Not configured",
        };
      }

      const source = ScheduleSourceSchema.parse(schedulerSource.schedule);

      if ("rateOf" in source) {
        const unit =
          "minutes" in source.rateOf
            ? source.rateOf.minutes > 1
              ? "minutes"
              : "minute"
            : "hours" in source.rateOf
            ? source.rateOf.hours > 1
              ? "hours"
              : "hour"
            : source.rateOf.days > 1
            ? "days"
            : "day";

        const value =
          "minutes" in source.rateOf
            ? source.rateOf.minutes
            : "hours" in source.rateOf
            ? source.rateOf.hours
            : source.rateOf.days;

        return {
          type: workflow.type,
          typeTitle: "Schedule",
          title: `Every ${value} ${unit}`,
        };
      } else {
        return {
          type: workflow.type,
          typeTitle: "Schedule",
          title: cronstrue.toString(source.cron, {
            throwExceptionOnParseError: false,
            verbose: false,
            use24HourTimeFormat: true,
          }),
          properties: [{ key: "Cron Expression", value: source.cron }],
        };
      }
    }
    case "CUSTOM_EVENT":
      return {
        type: workflow.type,
        typeTitle: "Custom event",
        title: `on: ${workflow.eventNames.join(", ")}`,
      };
    case "SLACK_INTERACTION": {
      if (!internalSource) {
        return {
          type: workflow.type,
          typeTitle: "Slack interaction",
          title: "on: Slack interaction",
        };
      }

      const slackSource = SlackInteractionSourceSchema.safeParse(
        internalSource.source
      );

      if (!slackSource.success) {
        return {
          type: workflow.type,
          typeTitle: "Slack interaction",
          title: "on: Slack interaction",
        };
      }

      const title =
        slackSource.data.type === "block_action"
          ? `block_id = ${slackSource.data.blockId}`
          : `callback_id = ${slackSource.data.callbackIds.join(", ")}`;

      return {
        type: workflow.type,
        typeTitle: "Slack interaction",
        title: title,
        properties:
          slackSource.data.type === "block_action" &&
          slackSource.data.actionIds.length > 0
            ? [
                {
                  key: "Action ID",
                  value: slackSource.data.actionIds.join(", "),
                },
              ]
            : undefined,
      };
    }
    default: {
      return {
        type: workflow.type,
        typeTitle: triggerLabel(workflow.type),
        title: workflow.type,
      };
    }
  }
}
