import { z } from "zod";
import { Prisma } from "~/db.server";
import { prisma } from "~/db.server";

const UniqueConstraintErrorTargetSchema = z.object({
  target: z.array(z.string()),
});

export async function createStepOnce(
  runId: string,
  key: string,
  data: Omit<Prisma.WorkflowRunStepCreateInput, "run" | "idempotencyKey">
) {
  const existingStep = await prisma.workflowRunStep.findUnique({
    where: {
      runId_idempotencyKey: {
        runId,
        idempotencyKey: key,
      },
    },
  });

  if (existingStep) {
    return { status: "EXISTING" as const, step: existingStep };
  }

  try {
    const step = await prisma.workflowRunStep.create({
      data: {
        ...data,
        idempotencyKey: key,
        runId,
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
