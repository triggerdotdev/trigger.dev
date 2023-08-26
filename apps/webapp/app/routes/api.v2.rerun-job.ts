import type { ActionArgs } from "@remix-run/server-runtime";
import { json } from "@remix-run/server-runtime";
import { authenticateApiRequest } from "~/services/PATAuth.server";
import { generateErrorMessage } from "zod-error";
import { ContinueRunService } from "~/services/runs/continueRun.server";
import { ReRunService } from "~/services/runs/reRun.server";
import { RerunJobSchema } from "@trigger.dev/core";

export async function action({ request }: ActionArgs) {
  const authenticationResult = await authenticateApiRequest(request);

  if (!authenticationResult) {
    return json({ error: "Invalid or Missing Personal Access Token" }, { status: 401 });
  }
  const anyBody = await request.json();

  const body = RerunJobSchema.safeParse(anyBody);

  if (!body.success) {
    return json({ message: generateErrorMessage(body.error.issues) }, { status: 422 });
  }
  try {
    const { runId, intent } = body.data
    if (intent === "start") {
      const rerunService = new ReRunService();
      const run = await rerunService.call({ runId });

      if (!run) {
        return json({ message: "Unable to retry run" }, { status: 400 });
      }
      return json({ message: `Created new run`, runId: run.id });
    } else if (intent === "continue") {

      const continueService = new ContinueRunService();
      await continueService.call({ runId });
      return json({ message: `Resuming run ${runId}` });
    }
  } catch (error) {
    return json({ errors: { body: (error as Error).message } }, { status: 400 });
  }
}
