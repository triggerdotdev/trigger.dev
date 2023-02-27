import type { ActionArgs } from "@remix-run/server-runtime";
import { json } from "@remix-run/server-runtime";
import { z } from "zod";
import { analytics } from "~/services/analytics.server";
import { authenticateApiRequest } from "~/services/apiAuth.server";

const BodySchema = z.object({
  id: z.string(),
  event: z.string(),
  properties: z.record(z.union([z.string(), z.number()]), z.any()),
});

export async function action({ request }: ActionArgs) {
  // first make sure this is a POST request
  if (request.method.toUpperCase() !== "POST") {
    return json({ error: "Method not allowed" }, { status: 405 });
  }

  const rawBody = await request.json();
  const body = BodySchema.parse(rawBody);

  // Next authenticate the request
  const authenticatedEnv = await authenticateApiRequest(request);

  const event = {
    userId: body.id,
    event: body.event,
    properties: {
      ...body.properties,
      environmentType: authenticatedEnv?.slug,
    },
    organizationId: authenticatedEnv?.organizationId,
    environmentId: authenticatedEnv?.id,
  };

  console.log("Capturing event", event);

  analytics.telemetry.capture(event);

  return json({ status: "OK" });
}
