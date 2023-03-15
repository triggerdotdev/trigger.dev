import type {
  KVDeleteOperation,
  KVGetOperation,
  KVSetOperation,
} from "@trigger.dev/common-schemas";
import type { PrismaClient } from "~/db.server";
import { prisma } from "~/db.server";
import type { WorkflowRunStep } from "~/models/workflowRun.server";
import { createStepOnce } from "~/models/workflowRunStep.server";
import { taskQueue } from "../messageBroker.server";

export class KVGetService {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  async call(
    key: string,
    runId: string,
    apiKey: string,
    timestamp: string,
    data: KVGetOperation
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

    const fullKey = `${data.namespace}:${data.key}`;

    const kvItem = await this.#prismaClient.keyValueItem.findUnique({
      where: {
        environmentId_key: {
          environmentId: environment.id,
          key: fullKey,
        },
      },
    });

    const idempotentStep = await createStepOnce(workflowRun.id, key, {
      type: "KV_GET",
      input: data,
      output: kvItem?.value ? kvItem.value : undefined,
      context: {},
      status: "SUCCESS",
      ts: timestamp,
    });

    return {
      output: idempotentStep.step.output,
      environment,
    };
  }
}

export class KVSetService {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  async call(
    key: string,
    runId: string,
    apiKey: string,
    timestamp: string,
    data: KVSetOperation
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

    const fullKey = `${data.namespace}:${data.key}`;
    const value = JSON.parse(JSON.stringify(data.value));

    const idempotentStep = await createStepOnce(workflowRun.id, key, {
      type: "KV_SET",
      input: {
        ...data,
        value,
      },
      context: {},
      status: "PENDING",
      ts: timestamp,
    });

    if (idempotentStep.status === "EXISTING") {
      return environment;
    }

    await this.#prismaClient.keyValueItem.upsert({
      where: {
        environmentId_key: {
          environmentId: environment.id,
          key: fullKey,
        },
      },
      update: {
        value,
      },
      create: {
        environmentId: environment.id,
        key: fullKey,
        value,
      },
    });

    await this.#prismaClient.workflowRunStep.update({
      where: {
        id: idempotentStep.step.id,
      },
      data: {
        status: "SUCCESS",
      },
    });

    return environment;
  }
}

export class KVDeleteService {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  async call(
    key: string,
    runId: string,
    apiKey: string,
    timestamp: string,
    data: KVDeleteOperation
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

    const fullKey = `${data.namespace}:${data.key}`;

    const idempotentStep = await createStepOnce(workflowRun.id, key, {
      type: "KV_DELETE",
      input: data,
      context: {},
      status: "PENDING",
      ts: timestamp,
    });

    if (idempotentStep.status === "EXISTING") {
      return environment;
    }

    await this.#prismaClient.keyValueItem.delete({
      where: {
        environmentId_key: {
          environmentId: environment.id,
          key: fullKey,
        },
      },
    });

    await this.#prismaClient.workflowRunStep.update({
      where: {
        id: idempotentStep.step.id,
      },
      data: {
        status: "SUCCESS",
      },
    });

    return environment;
  }
}
