import type { ActionArgs } from "@remix-run/server-runtime";
import { BuildFailed } from "~/features/ee/projects/services/buildFailed.server";

export async function action({ request }: ActionArgs) {
  const payload = await request.json();

  const service = new BuildFailed();

  const validation = service.validate(payload);

  if (!validation.success) {
    return new Response(JSON.stringify(validation.error), {
      status: 400,
    });
  }

  await service.call(validation.data);

  return new Response("OK", {
    status: 200,
  });
}
