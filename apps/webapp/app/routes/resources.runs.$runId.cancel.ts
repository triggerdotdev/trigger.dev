import { parse } from "@conform-to/zod";
import { ActionFunction, json } from "@remix-run/node";
import { z } from "zod";
import { redirectWithSuccessMessage } from "~/models/message.server";
import { CancelRunService } from "~/services/runs/cancelRun.server";

export const cancelSchema = z.object({
  redirectUrl: z.string(),
});

const ParamSchema = z.object({
  runId: z.string(),
});

export const action: ActionFunction = async ({ request, params }) => {
  const { runId } = ParamSchema.parse(params);

  const formData = await request.formData();
  const submission = parse(formData, { schema: cancelSchema });

  if (!submission.value) {
    return json(submission);
  }

  try {
    const cancelRunService = new CancelRunService();
    await cancelRunService.call({ runId });

    return redirectWithSuccessMessage(
      submission.value.redirectUrl,
      request,
      `Canceled run. Any pending tasks will be canceled.`
    );
  } catch (error: any) {
    return json({ errors: { body: error.message } }, { status: 400 });
  }
};
