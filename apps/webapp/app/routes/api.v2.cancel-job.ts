import type { ActionArgs } from "@remix-run/server-runtime";
import { json } from "@remix-run/server-runtime";
import { authenticateApiRequest } from "~/services/PATAuth.server";
import { generateErrorMessage } from "zod-error";
import { CancelRunService } from "~/services/runs/cancelRun.server";
import { logger } from "~/services/logger.server";
import { CancelJobSchema } from "@trigger.dev/core";


export async function action({ request }: ActionArgs) {
  const authenticationResult = await authenticateApiRequest(request);

  if (!authenticationResult) {
    return json({ error: "Invalid or Missing Personal Access Token" }, { status: 401 });
  }
  const anyBody = await request.json();
  const body = CancelJobSchema.safeParse(anyBody);

  if (!body.success) {
    return json({ message: generateErrorMessage(body.error.issues) }, { status: 422 });
  }
  const { runId } = body.data;

  try {
    const cancelRunService = new CancelRunService();
    await cancelRunService.call({ runId });

    return json({ message: "Canceled run. Any pending tasks will be canceled." }, { status: 200 });
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
}
