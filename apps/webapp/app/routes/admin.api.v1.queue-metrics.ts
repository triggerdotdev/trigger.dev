import { withAdminApi } from "~/services/adminApi.server";
import { type ActionFunctionArgs, type LoaderFunctionArgs, json } from "@remix-run/server-runtime";
import { z } from "zod";
import { requireAdminApiRequest } from "~/services/personalAccessToken.server";
import {
  probeQueueMetricsStreams,
  readQueueMetricsControls,
  writeQueueMetricsControls,
} from "~/v3/queueMetrics.server";

async function handleLoader({ request }: LoaderFunctionArgs) {
  await requireAdminApiRequest(request);
  const [controls, streams] = await Promise.all([
    readQueueMetricsControls(),
    probeQueueMetricsStreams(),
  ]);
  return json({ controls, streams });
}

const BodySchema = z.object({
  enabled: z.boolean().optional(),
  sampleRate: z.number().min(0).max(1).optional(),
});

async function handleAction({ request }: ActionFunctionArgs) {
  await requireAdminApiRequest(request);

  if (request.method !== "POST") {
    return json({ error: "Method not allowed" }, { status: 405 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = BodySchema.safeParse(body);
  if (!parsed.success) {
    return json({ error: "Invalid payload", details: parsed.error.issues }, { status: 400 });
  }

  await writeQueueMetricsControls(parsed.data);
  return json({ ok: true, controls: await readQueueMetricsControls() });
}

export const loader = withAdminApi(handleLoader);
export const action = withAdminApi(handleAction);
