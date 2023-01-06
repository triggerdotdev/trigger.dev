import type { ActionArgs } from "@remix-run/server-runtime";
import { json } from "@remix-run/server-runtime";
import { typedjson } from "remix-typedjson";
import invariant from "tiny-invariant";
import { z } from "zod";
import { connectExternalService } from "~/models/externalService.server";
import { taskQueue } from "~/services/messageBroker.server";
import { requireUserId } from "~/services/session.server";

const requestSchema = z.object({
  connectionId: z.string(),
});

// PUT /resources/sources/:sourceId
/** This is used to connect an external source with a connection to an API */
export async function action({ request, params }: ActionArgs) {
  await requireUserId(request);

  const { serviceId } = params;
  invariant(serviceId, "serviceId is required");

  // first make sure this is a PUT request
  if (request.method.toUpperCase() !== "PUT") {
    return json({ error: "Method not allowed" }, { status: 405 });
  }

  try {
    const formData = await request.formData();
    const formObject = Object.fromEntries(formData.entries());
    const { connectionId } = requestSchema.parse(formObject);
    await connectExternalService({ serviceId, connectionId });

    await taskQueue.publish("EXTERNAL_SERVICE_UPSERTED", {
      id: serviceId,
    });

    return typedjson({ success: true });
  } catch (error: any) {
    console.error(error);
    return typedjson({ error: error.message }, { status: 400 });
  }
}
