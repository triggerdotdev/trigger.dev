import type { PrismaClient } from "~/db.server";
import { prisma } from "~/db.server";
import type { Organization } from "~/models/organization.server";

export class CreateIntegrationRequest {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  async call(
    apiKey: string,
    workflowRunId: string,
    data: {
      id: string;
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
        id: workflowRunId,
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
            },
          });
        }
      }
    }
    // Create the workflow run step
    const workflowRunStep = await this.#prismaClient.workflowRunStep.create({
      data: {
        runId: workflowRun.id,
        type: "INTEGRATION_REQUEST",
        input: data.params,
        context: {
          service: data.service,
          endpoint: data.endpoint,
        },
        status: "PENDING",
      },
    });

    // Create the integration request
    const integrationRequest =
      await this.#prismaClient.integrationRequest.create({
        data: {
          id: data.id,
          params: data.params,
          endpoint: data.endpoint,
          externalServiceId: externalService.id,
          runId: workflowRun.id,
          stepId: workflowRunStep.id,
          status: "PENDING",
        },
      });

    return integrationRequest;
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
