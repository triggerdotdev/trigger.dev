import { type ActionFunctionArgs, json } from "@remix-run/server-runtime";
import { z } from "zod";
import { backfillBillingAlerts } from "~/services/billingAlertsBackfiller.server";
import { requireAdminApiRequest } from "~/services/personalAccessToken.server";

const Body = z.object({
  cursor: z.string().optional(),
  batchSize: z.number().int().positive().max(500).optional(),
  dryRun: z.boolean().optional(),
});

export async function action({ request }: ActionFunctionArgs) {
  await requireAdminApiRequest(request);

  try {
    const body = await request.json();
    const { cursor, batchSize, dryRun } = Body.parse(body);

    const result = await backfillBillingAlerts({ cursor, batchSize, dryRun });

    return json({ success: true, ...result });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : error }, { status: 400 });
  }
}
