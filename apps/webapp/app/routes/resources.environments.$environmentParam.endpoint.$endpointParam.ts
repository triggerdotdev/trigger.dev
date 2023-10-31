import { ActionFunctionArgs, json } from "@remix-run/server-runtime";
import { z } from "zod";
import { IndexEndpointService } from "~/services/endpoints/indexEndpoint.server";
import { workerQueue } from "~/services/worker.server";

const ParamsSchema = z.object({
  environmentParam: z.string(),
  endpointParam: z.string(),
});

export async function action({ params }: ActionFunctionArgs) {
  const { endpointParam } = ParamsSchema.parse(params);

  try {
    const service = new IndexEndpointService();
    await service.call(endpointParam, "MANUAL");

    // Enqueue the endpoint to be probed in 10 seconds
    await workerQueue.enqueue(
      "probeEndpoint",
      { id: endpointParam },
      { jobKey: `probe:${endpointParam}`, runAt: new Date(Date.now() + 10000) }
    );

    return json({ success: true });
  } catch (e) {
    return json({ success: false, error: e }, { status: 400 });
  }
}
