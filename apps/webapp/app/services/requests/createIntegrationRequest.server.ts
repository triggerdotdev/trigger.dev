import type { PrismaClient } from "~/db.server";
import { prisma } from "~/db.server";
import type { Organization } from "~/models/organization.server";
import type { WorkflowRunStep } from "~/models/workflowRun.server";
import { createStepOnce } from "~/models/workflowRunStep.server";
import { taskQueue } from "../messageBroker.server";

export class CreateIntegrationRequest {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  async call(
    key: string,
    runId: string,
    apiKey: string,
    timestamp: string,
    data: {
      service: string;
      endpoint: string;
      params?: any;
    }
  ) {
    const environment = await this.#prismaClient.runtimeEnvironment.findUnique({
      where: {
        apiKey,
      },
      include: {
        organization: true,
      },
    });

    if (!environment) {
      throw new Error("Invalid API key");
    }

    const workflowRun = await this.#prismaClient.workflowRun.findUnique({
      where: {
        id: runId,
      },
      include: {
        workflow: true,
      },
    });

    if (!workflowRun) {
      throw new Error("Invalid workflow run ID");
    }

    if (workflowRun.workflow.organizationId !== environment.organizationId) {
      throw new Error("Invalid workflow run ID");
    }

    // Create the workflow run step
    const idempotentStep = await createStepOnce(workflowRun.id, key, {
      type: "INTEGRATION_REQUEST",
      input: data.params,
      context: {
        service: data.service,
        endpoint: data.endpoint,
      },
      status: "PENDING",
      ts: timestamp,
    });

    if (idempotentStep.status === "EXISTING") {
      return this.#handleExistingStep(idempotentStep.step);
    }

    const workflowRunStep = idempotentStep.step;

    // Find existing external service for this workflow and service
    // If it doesn't exist, create it

    let externalService = await this.#prismaClient.externalService.findUnique({
      where: {
        workflowId_slug: {
          workflowId: workflowRun.workflowId,
          slug: data.service,
        },
      },
    });

    if (!externalService) {
      const existingConnection = await this.#findLatestExistingConnectionInOrg(
        data.service,
        environment.organization
      );

      externalService = await this.#prismaClient.externalService.create({
        data: {
          workflowId: workflowRun.workflowId,
          slug: data.service, // For now, we'll use the service name as the slug but this could change
          service: data.service,
          type: "HTTP_API",
          connectionId: existingConnection?.id,
          status: existingConnection ? "READY" : "CREATED",
        },
      });
    } else {
      if (!externalService.connectionId) {
        const existingConnection =
          await this.#findLatestExistingConnectionInOrg(
            data.service,
            environment.organization
          );

        if (existingConnection) {
          externalService = await this.#prismaClient.externalService.update({
            where: {
              id: externalService.id,
            },
            data: {
              connectionId: existingConnection.id,
              status: existingConnection ? "READY" : "CREATED",
            },
          });
        }
      }
    }

    // Create the integration request
    const integrationRequest =
      await this.#prismaClient.integrationRequest.create({
        data: {
          params: data.params,
          endpoint: data.endpoint,
          externalServiceId: externalService.id,
          runId: workflowRun.id,
          stepId: workflowRunStep.id,
          status: "PENDING",
        },
      });

    await taskQueue.publish("INTEGRATION_REQUEST_CREATED", {
      id: integrationRequest.id,
    });

    return integrationRequest;
  }

  async #handleExistingStep(step: WorkflowRunStep) {
    const integrationRequest =
      await this.#prismaClient.integrationRequest.findUnique({
        where: {
          stepId: step.id,
        },
      });

    if (!integrationRequest) {
      return;
    }

    if (
      integrationRequest.status === "SUCCESS" ||
      integrationRequest.status === "ERROR"
    ) {
      await taskQueue.publish("RESOLVE_INTEGRATION_REQUEST", {
        id: integrationRequest.id,
      });
    }
  }

  async #findLatestExistingConnectionInOrg(
    serviceIdentifier: string,
    organization: Organization
  ) {
    const connection = await this.#prismaClient.aPIConnection.findFirst({
      where: {
        organizationId: organization.id,
        apiIdentifier: serviceIdentifier,
        status: "CONNECTED",
      },
      orderBy: {
        createdAt: "desc",
      },
    });

    return connection;
  }
}
