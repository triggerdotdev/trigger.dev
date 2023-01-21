import type { FetchRequest } from "@trigger.dev/common-schemas";
import type { PrismaClient } from "~/db.server";
import { prisma } from "~/db.server";
import type { WorkflowRunStep } from "~/models/workflowRun.server";
import { createStepOnce } from "~/models/workflowRunStep.server";
import { taskQueue } from "../messageBroker.server";

export class CreateFetchRequest {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  async call(
    key: string,
    runId: string,
    apiKey: string,
    timestamp: string,
    data: FetchRequest
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

    const idempotentStep = await createStepOnce(workflowRun.id, key, {
      type: "FETCH_REQUEST",
      input: data,
      context: {},
      status: "PENDING",
      ts: timestamp,
    });

    if (idempotentStep.status === "EXISTING") {
      return this.#handleExistingStep(idempotentStep.step);
    }

    const workflowRunStep = idempotentStep.step;

    // Create the integration request
    const fetchRequest = await this.#prismaClient.fetchRequest.create({
      data: {
        fetch: data,
        runId: workflowRun.id,
        stepId: workflowRunStep.id,
        status: "PENDING",
      },
    });

    await taskQueue.publish("FETCH_REQUEST_CREATED", {
      id: fetchRequest.id,
    });

    return fetchRequest;
  }

  async #handleExistingStep(step: WorkflowRunStep) {
    const fetchRequest = await this.#prismaClient.fetchRequest.findUnique({
      where: {
        stepId: step.id,
      },
    });

    if (!fetchRequest) {
      return;
    }

    if (fetchRequest.status === "SUCCESS" || fetchRequest.status === "ERROR") {
      await taskQueue.publish("RESOLVE_FETCH_REQUEST", {
        id: fetchRequest.id,
      });
    }
  }
}
