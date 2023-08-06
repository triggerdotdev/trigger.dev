import { parse } from "@conform-to/zod";
import { ActionFunction, json } from "@remix-run/node";
import { z } from "zod";
import { redirectBackWithErrorMessage, redirectWithSuccessMessage } from "~/models/message.server";
import { ContinueRunService } from "~/services/runs/continueRun.server";
import { ReRunService } from "~/services/runs/reRun.server";

export const schema = z.object({
  successRedirect: z.string(),
});

const ParamSchema = z.object({
  runId: z.string(),
});

export const action: ActionFunction = async ({ request, params }) => {
  const { runId } = ParamSchema.parse(params);

  const formData = await request.formData();
  const submission = parse(formData, { schema });

  if (!submission.value) {
    return json(submission);
  }

  try {
    if (submission.intent === "start") {
      const rerunService = new ReRunService();
      const run = await rerunService.call({ runId });

      if (!run) {
        return redirectBackWithErrorMessage(request, "Unable to retry run");
      }

      return redirectWithSuccessMessage(
        `${submission.value.successRedirect}/${run.id}`,
        request,
        `Created new run`
      );
    } else if (submission.intent === "continue") {
      const continueService = new ContinueRunService();
      await continueService.call({ runId });

      return redirectWithSuccessMessage(
        `${submission.value.successRedirect}/${runId}`,
        request,
        `Resuming run`
      );
    }
  } catch (error: any) {
    return json({ errors: { body: error.message } }, { status: 400 });
  }
};
