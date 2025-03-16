import { parse } from "@conform-to/zod";
import { ActionFunction, json } from "@remix-run/node";
import { assertExhaustive } from "@trigger.dev/core/utils";
import { z } from "zod";
import { redirectWithErrorMessage, redirectWithSuccessMessage } from "~/models/message.server";
import { logger } from "~/services/logger.server";
import { ResumeBatchRunService } from "~/v3/services/resumeBatchRun.server";

export const checkCompletionSchema = z.object({
  redirectUrl: z.string(),
});

const ParamSchema = z.object({
  batchId: z.string(),
});

export const action: ActionFunction = async ({ request, params }) => {
  const { batchId } = ParamSchema.parse(params);

  const formData = await request.formData();
  const submission = parse(formData, { schema: checkCompletionSchema });

  if (!submission.value) {
    return json(submission);
  }

  try {
    const resumeBatchRunService = new ResumeBatchRunService();
    const resumeResult = await resumeBatchRunService.call(batchId);

    let message: string | undefined;

    switch (resumeResult) {
      case "ERROR": {
        throw "Unknown error during batch completion check";
      }
      case "ALREADY_COMPLETED": {
        message = "Batch already completed.";
        break;
      }
      case "COMPLETED": {
        message = "Batch completed and parent tasks resumed.";
        break;
      }
      case "PENDING": {
        message = "Child runs still in progress. Please try again later.";
        break;
      }
      default: {
        assertExhaustive(resumeResult);
      }
    }

    return redirectWithSuccessMessage(submission.value.redirectUrl, request, message);
  } catch (error) {
    if (error instanceof Error) {
      logger.error("Failed to check batch completion", {
        error: {
          name: error.name,
          message: error.message,
          stack: error.stack,
        },
      });
      return redirectWithErrorMessage(submission.value.redirectUrl, request, error.message);
    } else {
      logger.error("Failed to check batch completion", { error });
      return redirectWithErrorMessage(submission.value.redirectUrl, request, "Unknown error");
    }
  }
};
