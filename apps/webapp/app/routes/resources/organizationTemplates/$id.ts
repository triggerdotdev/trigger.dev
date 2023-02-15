import { LoaderArgs } from "@remix-run/server-runtime";
import { eventStream } from "remix-utils";
import { z } from "zod";
import { createEventEmitter } from "~/services/messageBroker.server";
import { requireUserId } from "~/services/session.server";

export async function loader({ request, params }: LoaderArgs) {
  const userId = await requireUserId(request);
  const { id } = z.object({ id: z.string() }).parse(params);

  const eventEmitter = await createEventEmitter({
    id: `${id}-${userId}`,
    filter: {
      "x-organization-template-id": id,
    },
  });

  return eventStream(request.signal, (send) => {
    eventEmitter.on("organization-template.updated", (data) => {
      send({ data: JSON.stringify(data) });
    });

    return function clear() {
      eventEmitter.removeAllListeners();
    };
  });
}
