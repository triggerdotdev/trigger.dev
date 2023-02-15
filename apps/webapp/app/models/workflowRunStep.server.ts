import { DisplayProperties } from "@trigger.dev/integration-sdk";
import { z } from "zod";
import { Prisma } from "~/db.server";
import { prisma } from "~/db.server";
import { integrationsClient } from "~/services/integrationsClient.server";

const UniqueConstraintErrorTargetSchema = z.object({
  target: z.array(z.string()),
});

export async function createStepOnce(
  config: {
    runId: string;
    key: string;
    service: string;
    endpoint: string;
    params?: any;
    version?: string;
  },
  data: Omit<Prisma.WorkflowRunStepCreateInput, "run" | "idempotencyKey">
) {
  const existingStep = await prisma.workflowRunStep.findUnique({
    where: {
      runId_idempotencyKey: {
        runId: config.runId,
        idempotencyKey: config.key,
      },
    },
  });

  if (existingStep) {
    return { status: "EXISTING" as const, step: existingStep };
  }

  try {
    let displayProperties: DisplayProperties | undefined = undefined;
    if (config.version === "2") {
      displayProperties = await integrationsClient.displayProperties({
        service: config.service,
        name: config.endpoint,
        params: config.params,
      });
    }

    const step = await prisma.workflowRunStep.create({
      data: {
        ...data,
        displayProperties,
        idempotencyKey: config.key,
        runId: config.runId,
      },
    });

    return { status: "CREATED" as const, step };
  } catch (e) {
    if (
      e instanceof Prisma.PrismaClientKnownRequestError &&
      e.code === "P2002" &&
      UniqueConstraintErrorTargetSchema.safeParse(e.meta).success &&
      UniqueConstraintErrorTargetSchema.parse(e.meta).target.includes(
        "idempotencyKey"
      )
    ) {
      const existingStep = await prisma.workflowRunStep.findUnique({
        where: {
          runId_idempotencyKey: {
            runId,
            idempotencyKey: key,
          },
        },
      });

      if (!existingStep) {
        throw new Error(
          "Received a unique constraint error for idempotencyKey, but the step doesn't exist."
        );
      }

      return { status: "EXISTING" as const, step: existingStep };
    }

    throw e;
  }
}

export async function findWorkflowStepById(stepId: string) {
  return prisma.workflowRunStep.findUnique({
    where: {
      id: stepId,
    },
    include: {
      run: {
        include: {
          workflow: true,
          environment: {
            include: {
              organization: true,
            },
          },
        },
      },
    },
  });
}
