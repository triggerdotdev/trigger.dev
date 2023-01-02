import type { ActionArgs } from "@remix-run/server-runtime";
import { json } from "@remix-run/server-runtime";
import { z } from "zod";
import { setConnectedAPIConnection } from "~/models/apiConnection.server";
import { connectExternalService } from "~/models/externalService.server";
import { connectExternalSource } from "~/models/externalSource.server";
import { internalPubSub } from "~/services/messageBroker.server";
import { requireUserId } from "~/services/session.server";

const requestSchema = z.object({
  connectionId: z.string(),
  sourceId: z.string().optional(),
  serviceId: z.string().optional(),
});
export type Request = z.infer<typeof requestSchema>;

export type Response = {
  success: boolean;
};

export const action = async ({ request, params }: ActionArgs) => {
  const userId = await requireUserId(request);
  if (userId === null) {
    throw new Response("Unauthorized", { status: 401 });
  }

  if (request.method !== "PUT") {
    throw new Response("Method Not Allowed", { status: 405 });
  }

  try {
    const formData = await request.formData();
    const body = Object.fromEntries(formData.entries());
    const { connectionId, sourceId, serviceId } = requestSchema.parse(body);

    await setConnectedAPIConnection({
      id: connectionId,
    });

    if (sourceId !== undefined) {
      await connectExternalSource({ sourceId, connectionId });
      await internalPubSub.publish("EXTERNAL_SOURCE_UPSERTED", {
        id: sourceId,
      });
    }
    if (serviceId !== undefined) {
      await connectExternalService({ serviceId, connectionId });
      await internalPubSub.publish("EXTERNAL_SERVICE_UPSERTED", {
        id: serviceId,
      });
    }

    return json({
      success: true,
    });
  } catch (error: any) {
    console.log("error", error);
    return json({ message: error.message }, { status: 400 });
  }
};
