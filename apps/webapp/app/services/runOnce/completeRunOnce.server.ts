import type { CompleteRunOnceSchema } from "@trigger.dev/common-schemas";
import type { z } from "zod";
import type { PrismaClient } from "~/db.server";
import { prisma } from "~/db.server";

type RunOnce = z.infer<typeof CompleteRunOnceSchema>;

export class CompleteRunOnce {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  async call(runOnce: RunOnce) {
    return this.#prismaClient.workflowRunStep.updateMany({
      where: {
        id: runOnce.idempotencyKey,
        status: "RUNNING",
      },
      data: {
        status: "SUCCESS",
        finishedAt: new Date(),
        output:
          runOnce.type === "REMOTE" && typeof runOnce.output === "string"
            ? safeOutputParse(runOnce.output)
            : undefined,
      },
    });
  }
}

function safeOutputParse(output?: string) {
  if (typeof output !== "string") {
    return;
  }

  try {
    return JSON.parse(output);
  } catch (e) {
    return;
  }
}
