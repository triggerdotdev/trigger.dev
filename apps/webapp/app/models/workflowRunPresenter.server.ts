import {
  CustomEventSchema,
  ErrorSchema,
  LogMessageSchema,
  TriggerMetadataSchema,
  WaitSchema,
} from "@trigger.dev/common-schemas";
import type { DisplayProperties } from "internal-integrations";
import { slack, shopify } from "internal-integrations";
import type { Provider } from "internal-providers";
import invariant from "tiny-invariant";
import type { PrismaClient } from "~/db.server";
import { prisma } from "~/db.server";
import type { PrismaReturnType } from "~/utils";
import { dateDifference } from "~/utils";
import { getIntegrations } from "./integrations.server";
import type { WorkflowRunStatus } from "./workflowRun.server";

export class WorkflowRunPresenter {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  async data(id: string) {
    const workflowRun = await getWorkflowRun(this.#prismaClient, id);

    if (!workflowRun) {
      throw new Error(`Workflow run with id ${id} not found`);
    }

    const integrations = getIntegrations(true);
    const steps = await Promise.all(
      workflowRun.tasks.map((step) => parseStep(step, integrations))
    );

    const trigger = {
      startedAt: workflowRun.startedAt,
      status: triggerStatus(steps.length, workflowRun.status),
      input: workflowRun.event.payload,
      eventName: workflowRun.event.name,
      ...(await parseTrigger(workflowRun.eventRule.trigger)),
    };

    return {
      id: workflowRun.id,
      status: workflowRun.status,
      startedAt: workflowRun.startedAt,
      finishedAt: workflowRun.finishedAt,
      isTest: workflowRun.isTest,
      duration:
        workflowRun.startedAt &&
        workflowRun.finishedAt &&
        dateDifference(workflowRun.startedAt, workflowRun.finishedAt),
      trigger,
      steps,
      error: workflowRun.error
        ? await ErrorSchema.parseAsync(workflowRun.error)
        : undefined,
    };
  }
}

async function parseTrigger(original: unknown) {
  return TriggerMetadataSchema.parseAsync(original);
}

async function parseStep(
  original: NonNullable<
    PrismaReturnType<typeof getWorkflowRun>
  >["tasks"][number],
  integrations: Provider[]
) {
  const status = stepStatus(original.finishedAt);
  const base = {
    id: original.id,
    startedAt: original.startedAt,
    finishedAt: original.finishedAt,
    status,
  };
  switch (original.type) {
    case "LOG_MESSAGE":
      return {
        ...base,
        type: "LOG_MESSAGE" as const,
        input: await LogMessageSchema.parseAsync(original.input),
      };
    case "CUSTOM_EVENT":
      return {
        ...base,
        type: "CUSTOM_EVENT" as const,
        input: await CustomEventSchema.parseAsync(original.input),
      };
    case "OUTPUT":
      return {
        ...base,
        type: "OUTPUT" as const,
        output: original.output,
      };
    case "DURABLE_DELAY":
      return {
        ...base,
        type: "DURABLE_DELAY" as const,
        input: await WaitSchema.parseAsync(original.input),
      };
    case "DISCONNECTION":
      return {
        ...base,
        type: "DISCONNECTION" as const,
      };
    case "INTEGRATION_REQUEST":
      invariant(
        original.integrationRequest,
        `Integration request is missing from run step ${original.id}}`
      );
      const externalService = original.integrationRequest.externalService;
      const integration = integrations.find(
        (i) => i.slug === externalService.slug
      );
      invariant(integration, `Integration ${externalService.slug} not found`);

      let displayProperties: DisplayProperties;

      switch (externalService.slug) {
        case "slack":
          displayProperties = slack.requests.displayProperties(
            original.integrationRequest.endpoint,
            original.integrationRequest.params
          );
          break;
        case "shopify":
          displayProperties = shopify.requests.displayProperties(
            original.integrationRequest.endpoint,
            original.integrationRequest.params
          );
          break;
        default:
          displayProperties = {
            title: "Unknown integration",
          };
      }

      return {
        ...base,
        type: "INTEGRATION_REQUEST" as const,
        input: original.input,
        output: original.output,
        context: original.context,
        displayProperties,
        service: {
          id: externalService.id,
          slug: externalService.slug,
          type: externalService.type,
          status: externalService.status,
          connection: externalService.connection,
          integration,
        },
        retryCount: original.integrationRequest.retryCount,
      };
  }

  throw new Error(`Unknown step type ${original.type}`);
}

function stepStatus(finishedAt: Date | null) {
  if (finishedAt) {
    return "SUCCESS" as const;
  } else {
    return "PENDING" as const;
  }
}

function triggerStatus(stepCount: number, workflowStatus: WorkflowRunStatus) {
  if (stepCount > 0) {
    return "SUCCESS" as const;
  }

  return workflowStatus;
}

function getWorkflowRun(prismaClient: PrismaClient, id: string) {
  return prismaClient.workflowRun.findUnique({
    where: { id },
    include: {
      eventRule: true,
      event: true,
      tasks: {
        include: {
          integrationRequest: {
            include: {
              externalService: {
                include: {
                  connection: true,
                },
              },
              responses: {
                orderBy: { createdAt: "desc" },
                take: 1,
              },
            },
          },
        },
        orderBy: { ts: "asc" },
      },
    },
  });
}
