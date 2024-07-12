import { type ActionFunctionArgs, json } from "@remix-run/server-runtime";
import { z } from "zod";
import { DeleteEndpointService } from "~/services/endpoints/deleteEndpointService";
import { IndexEndpointService } from "~/services/endpoints/indexEndpoint.server";
import { requireUserId } from "~/services/session.server";
import { workerQueue } from "~/services/worker.server";

const ParamsSchema = z.object({
  environmentParam: z.string(),
  endpointParam: z.string(),
});

const BodySchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("refresh") }),
  z.object({ action: z.literal("delete") }),
]);

export async function action({ request, params }: ActionFunctionArgs) {
  const userId = await requireUserId(request);
  if (request.method !== "POST") {
    throw new Response(null, { status: 405 });
  }

  try {
    const { endpointParam } = ParamsSchema.parse(params);
    const form = await request.formData();
    const formObject = Object.fromEntries(form.entries());
    const { action } = BodySchema.parse(formObject);

    switch (action) {
      case "refresh": {
        const service = new IndexEndpointService();
        await service.call(endpointParam, "MANUAL");

        // Enqueue the endpoint to be probed in 10 seconds
        await workerQueue.enqueue(
          "probeEndpoint",
          { id: endpointParam },
          { jobKey: `probe:${endpointParam}`, runAt: new Date(Date.now() + 10000) }
        );

        return json({ success: true });
      }
      case "delete": {
        const service = new DeleteEndpointService();
        await service.call(endpointParam, userId);
        return json({ success: true });
      }
    }
  } catch (e) {
    return json({ success: false, error: e }, { status: 400 });
  }
}
