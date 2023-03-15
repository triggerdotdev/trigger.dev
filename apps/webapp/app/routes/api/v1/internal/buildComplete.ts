import type { ActionArgs } from "@remix-run/server-runtime";
import { taskQueue } from "~/services/messageBroker.server";
import { BuildComplete } from "~/features/ee/projects/services/buildComplete.server";

export async function action({ request }: ActionArgs) {
  const payload = await request.json();

  const service = new BuildComplete();

  const validation = service.validate(payload);

  if (!validation.success) {
    return new Response(JSON.stringify(validation.error), {
      status: 400,
    });
  }

  await taskQueue.publish("DEPLOYMENT_BUILD_COMPLETE", validation.data);

  return new Response("OK", {
    status: 200,
  });
}
