import { parse } from "@conform-to/zod";
import { ActionFunction, json } from "@remix-run/node";
import { z } from "zod";
import { prisma } from "~/db.server";
import { redirectWithSuccessMessage } from "~/models/message.server";
import { logger } from "~/services/logger.server";
import { CancelRunService } from "~/services/runs/cancelRun.server";
import { requireUserId } from "~/services/session.server";

export const cancelSchema = z.object({
  redirectUrl: z.string(),
});

const ParamSchema = z.object({
  runId: z.string(),
});

export const action: ActionFunction = async ({ request, params }) => {
  const userId = await requireUserId(request);
  const { runId } = ParamSchema.parse(params);

  const formData = await request.formData();
  const submission = parse(formData, { schema: cancelSchema });

  if (!submission.value) {
    return json(submission);
  }

  try {
    const run = await prisma.jobRun.findUnique({
      select: {
        id: true,
      },
      where: {
        id: runId,
        job: {
          organization: {
            members: {
              some: {
                userId,
              },
            },
          },
        },
      },
    });

    if (!run) {
      return json({ errors: { body: "Run not found" } }, { status: 404 });
    }

    const cancelRunService = new CancelRunService();
    await cancelRunService.call({ runId: run.id });

    return redirectWithSuccessMessage(
      submission.value.redirectUrl,
      request,
      `Canceled run. Any pending tasks will be canceled.`
    );
  } catch (error) {
    if (error instanceof Error) {
      logger.error("Failed to cancel run", {
        error: {
          name: error.name,
          message: error.message,
          stack: error.stack,
        },
      });
      return json({ errors: { body: error.message } }, { status: 400 });
    } else {
      logger.error("Failed to cancel run", { error });
      return json({ errors: { body: "Unknown error" } }, { status: 400 });
    }
  }
};
