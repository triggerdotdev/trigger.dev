import { parse } from "@conform-to/zod";
import { type ActionFunction, json } from "@remix-run/node";
import { z } from "zod";
import { prisma } from "~/db.server";
import { redirectWithErrorMessage, redirectWithSuccessMessage } from "~/models/message.server";
import { logger } from "~/services/logger.server";
import { requireUserId } from "~/services/session.server";
import { CancelTaskRunService } from "~/v3/services/cancelTaskRun.server";

export const cancelSchema = z.object({
  redirectUrl: z.string(),
});

const ParamSchema = z.object({
  runParam: z.string(),
});

export const action: ActionFunction = async ({ request, params }) => {
  const userId = await requireUserId(request);
  const { runParam } = ParamSchema.parse(params);

  const formData = await request.formData();
  const submission = parse(formData, { schema: cancelSchema });

  if (!submission.value) {
    return json(submission);
  }

  try {
    const taskRun = await prisma.taskRun.findFirst({
      where: {
        friendlyId: runParam,
        project: {
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

    if (!taskRun) {
      submission.error = { runParam: ["Run not found"] };
      return json(submission);
    }

    const cancelRunService = new CancelTaskRunService();
    await cancelRunService.call(taskRun);

    return redirectWithSuccessMessage(submission.value.redirectUrl, request, `Canceled run`);
  } catch (error) {
    if (error instanceof Error) {
      logger.error("Failed to cancel run", {
        error: {
          name: error.name,
          message: error.message,
          stack: error.stack,
        },
      });
      return redirectWithErrorMessage(
        submission.value.redirectUrl,
        request,
        `Failed to cancel run, ${error.message}`
      );
    } else {
      logger.error("Failed to cancel run", { error });
      return redirectWithErrorMessage(
        submission.value.redirectUrl,
        request,
        `Failed to cancel run, ${JSON.stringify(error)}`
      );
    }
  }
};
