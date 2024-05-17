import { parse } from "@conform-to/zod";
import { ActionFunctionArgs } from "@remix-run/router";
import { z } from "zod";
import { redirectWithErrorMessage } from "~/models/message.server";
import { logger } from "~/services/logger.server";

const FormSchema = z.object({
  failedRedirect: z.string(),
  runIds: z.array(z.string()).or(z.string()),
});

export async function action({ request }: ActionFunctionArgs) {
  if (request.method.toLowerCase() !== "post") {
    return redirectWithErrorMessage("/", request, "Invalid method");
  }

  const formData = await request.formData();
  const submission = parse(formData, { schema: FormSchema });

  if (!submission.value) {
    logger.error("Failed to parse resources/taskruns/bulk/replay form data", { submission });
    return redirectWithErrorMessage("/", request, "Failed to parse form data");
  }

  try {
    //todo
    //Redirect user to a page showing the new runs, there won't be any so we should modify the no results filter message.

    //1. Create the BulkActionGroup with type Replay
    //2.
    //2. Add the taskRuns to the BulkActionGroup
    //3.

    // const replayRunService = new ReplayTaskRunService();
    // const newRun = await replayRunService.call(taskRun);

    // if (!newRun) {
    return redirectWithErrorMessage(
      submission.value.failedRedirect,
      request,
      "Failed to replay runs "
    );
    // }

    // const runPath = v3RunSpanPath(
    //   {
    //     slug: taskRun.project.organization.slug,
    //   },
    //   { slug: taskRun.project.slug },
    //   { friendlyId: newRun.friendlyId },
    //   { spanId: newRun.spanId }
    // );

    // logger.debug("Replayed run", {
    //   taskRunId: taskRun.id,
    //   taskRunFriendlyId: taskRun.friendlyId,
    //   newRunId: newRun.id,
    //   newRunFriendlyId: newRun.friendlyId,
    //   runPath,
    // });

    // return redirectWithSuccessMessage(runPath, request, `Replaying run`);
  } catch (error) {
    if (error instanceof Error) {
      logger.error("Failed to replay run", {
        error: {
          name: error.name,
          message: error.message,
          stack: error.stack,
        },
      });
      return redirectWithErrorMessage(submission.value.failedRedirect, request, error.message);
    } else {
      logger.error("Failed to replay run", { error });
      return redirectWithErrorMessage(
        submission.value.failedRedirect,
        request,
        JSON.stringify(error)
      );
    }
  }
}
