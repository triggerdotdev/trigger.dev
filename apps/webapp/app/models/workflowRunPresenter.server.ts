import type { SecureString } from "@trigger.dev/common-schemas";
import {
  CustomEventSchema,
  ErrorSchema,
  FetchRequestSchema,
  FetchResponseSchema,
  LogMessageSchema,
  TriggerMetadataSchema,
  WaitSchema,
} from "@trigger.dev/common-schemas";
import type {
  DisplayProperties,
  InternalIntegration,
} from "@trigger.dev/integration-sdk";
import { SendEmailBodySchema } from "@trigger.dev/resend/schemas";
import invariant from "tiny-invariant";
import type { PrismaClient } from "~/db.server";
import { prisma } from "~/db.server";
import type { PrismaReturnType } from "~/utils";
import { dateDifference } from "~/utils";
import { getIntegrationMetadata, getIntegrations } from "./integrations.server";
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

    let trigger = {
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
      trigger: {
        ...trigger,
        integration: getIntegrationMetadata(integrations, trigger.service),
      },
      steps,
      error: workflowRun.error
        ? await ErrorSchema.parseAsync(workflowRun.error)
        : undefined,
      timedOutReason: workflowRun.timedOutReason,
      integrations: integrations.map((i) => i.metadata),
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
  integrations: InternalIntegration[]
) {
  const base = {
    id: original.id,
    startedAt: original.startedAt,
    finishedAt: original.finishedAt,
    status: original.status,
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
    case "FETCH_REQUEST":
      invariant(
        original.fetchRequest,
        `Fetch request is missing from run step ${original.id}}`
      );

      const fetchRequest = FetchRequestSchema.parse(original.input);
      const lastFetchResponse = original.fetchRequest.responses[0];
      const lastResponse = lastFetchResponse
        ? FetchResponseSchema.safeParse(lastFetchResponse.output).success
          ? FetchResponseSchema.parse(lastFetchResponse.output)
          : undefined
        : undefined;

      return {
        ...base,
        type: "FETCH_REQUEST" as const,
        title: `${fetchRequest.method} ${fetchRequest.url}`,
        input: {
          headers: obfuscateHeaders(fetchRequest.headers),
          body: fetchRequest.body,
        },
        output: original.output,
        requestStatus: original.fetchRequest.status,
        retryCount: original.fetchRequest.retryCount,
        lastResponse,
      };
    case "INTEGRATION_REQUEST":
      invariant(
        original.integrationRequest,
        `Integration request is missing from run step ${original.id}}`
      );
      const externalService = original.integrationRequest.externalService;
      const integration = integrations.find(
        (i) => i.metadata.slug === externalService.slug
      );
      invariant(integration, `Integration ${externalService.slug} not found`);

      let displayProperties: DisplayProperties;

      if (integration.requests) {
        displayProperties = integration.requests.displayProperties(
          original.integrationRequest.endpoint,
          original.integrationRequest.params
        );
      } else {
        displayProperties = {
          title: "Unknown integration",
        };
      }

      const customComponent =
        integration.metadata.slug === "resend"
          ? {
              component: "resend" as const,
              input: SendEmailBodySchema.parse(original.input),
            }
          : undefined;

      return {
        ...base,
        type: "INTEGRATION_REQUEST" as const,
        input: original.input,
        output: original.output,
        context: original.context,
        requestStatus: original.integrationRequest.status,
        displayProperties,
        service: {
          id: externalService.id,
          slug: externalService.slug,
          type: externalService.type,
          status: externalService.status,
          connection: externalService.connection,
          integration: integration.metadata,
        },
        retryCount: original.integrationRequest.retryCount,
        customComponent,
      };
  }

  throw new Error(`Unknown step type ${original.type}`);
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
          fetchRequest: {
            include: {
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

function obfuscateHeaders(
  headers?: Record<string, string | SecureString>
): Record<string, string> {
  if (!headers) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [
      key,
      typeof value === "string" ? value : obfuscateSecureString(value),
    ])
  );
}

// SecureString is an object with { strings: string[]; interpolations: string[]; }
// So we need to build up a string from strings and replace interpolations with ****
function obfuscateSecureString(value: SecureString) {
  let result = "";

  for (let i = 0; i < value.strings.length; i++) {
    result += value.strings[i];
    if (i < value.interpolations.length) {
      result += "********";
    }
  }

  return result;
}
