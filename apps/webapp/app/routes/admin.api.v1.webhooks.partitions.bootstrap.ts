import { bootstrapPartitions } from "@internal/webhook-engine";
import { type ActionFunctionArgs, json } from "@remix-run/server-runtime";
import { webhookPartitionPrisma } from "~/db.server";
import { env } from "~/env.server";
import { requireAdminApiRequest } from "~/services/personalAccessToken.server";

export async function action({ request }: ActionFunctionArgs) {
  await requireAdminApiRequest(request);

  if (request.method !== "POST") {
    return json({ error: "Method not allowed" }, { status: 405, headers: { Allow: "POST" } });
  }

  const result = await bootstrapPartitions(webhookPartitionPrisma, {
    now: new Date(),
    lookaheadDays: env.WEBHOOK_PARTITION_LOOKAHEAD_DAYS,
    retentionDays: env.WEBHOOK_PARTITION_RETENTION_DAYS,
  });

  return json({ success: true, ...result });
}
