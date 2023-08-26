import type { ActionArgs } from "@remix-run/server-runtime";
import { json } from "@remix-run/server-runtime";
import { authenticateApiRequest } from "~/services/PATAuth.server";
import { TestJobService } from "~/services/jobs/testJob.server";
import { generateErrorMessage } from "zod-error";
import { TestJobSchema } from "@trigger.dev/core";

export async function action({ request }: ActionArgs) {
  const authenticationResult = await authenticateApiRequest(request);

  if (!authenticationResult) {
    return json({ error: "Invalid or Missing Personal Access Token" }, { status: 401 });
  }
  const anyBody = await request.json();

  const body = TestJobSchema.safeParse(anyBody);

  if (!body.success) {
    return json({ message: generateErrorMessage(body.error.issues) }, { status: 422 });
  }

  const { environmentId, payload, versionId } = body.data

  const testService = new TestJobService();
  const run = await testService.call({
    environmentId: environmentId,
    payload: payload,
    versionId: versionId,
  });

  if (!run) {
    return json({ error: "Unable to start a test run: Something went wrong" }, { status: 500 });
  }

  return json({ message: `Test run created for ${run.id}` });
}
