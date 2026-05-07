import { type ActionFunctionArgs, json } from "@remix-run/server-runtime";
import { z } from "zod";
import { requireAdminApiRequest } from "~/services/personalAccessToken.server";
import { adminWorker } from "~/v3/services/adminWorker.server";

const Body = z.object({
  from: z.coerce.date(),
  to: z.coerce.date(),
  batchSize: z.number().optional(),
  delayIntervalMs: z.number().optional(),
});

const Params = z.object({
  batchId: z.string(),
});

const DEFAULT_BATCH_SIZE = 500;
const DEFAULT_DELAY_INTERVAL_MS = 1000;

export async function action({ request, params }: ActionFunctionArgs) {
  await requireAdminApiRequest(request);

  const { batchId } = Params.parse(params);

  try {
    const body = await request.json();

    const { from, to, batchSize, delayIntervalMs } = Body.parse(body);

    await adminWorker.enqueue({
      job: "admin.backfillRunsToReplication",
      payload: {
        from,
        to,
        batchSize: batchSize ?? DEFAULT_BATCH_SIZE,
        delayIntervalMs: delayIntervalMs ?? DEFAULT_DELAY_INTERVAL_MS,
      },
      id: batchId,
    });

    return json({
      success: true,
      id: batchId,
    });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : error }, { status: 400 });
  }
}
