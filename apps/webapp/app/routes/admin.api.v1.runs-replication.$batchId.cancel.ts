import { type ActionFunctionArgs, json } from "@remix-run/server-runtime";
import { z } from "zod";
import { requireAdminApiRequest } from "~/services/personalAccessToken.server";
import { adminWorker } from "~/v3/services/adminWorker.server";

const Params = z.object({
  batchId: z.string(),
});

export async function action({ request, params }: ActionFunctionArgs) {
  await requireAdminApiRequest(request);

  const { batchId } = Params.parse(params);

  try {
    await adminWorker.cancel(batchId);

    return json({
      success: true,
      id: batchId,
    });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : error }, { status: 400 });
  }
}
