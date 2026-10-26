import type { ActionFunctionArgs } from "@remix-run/server-runtime";
import { json } from "@remix-run/server-runtime";
import { tryCatch } from "@trigger.dev/core/v3";
import { z } from "zod";
import { logger } from "~/services/logger.server";
import { requireAdminApiRequest } from "~/services/personalAccessToken.server";
import { TemplatePrebuildService } from "~/v3/services/templatePrebuild.server";

const BodySchema = z.object({
  // Deployment ids or friendly ids.
  deploymentIds: z.array(z.string().min(1)).min(1).max(50),
  force: z.boolean().default(false),
});

export async function action({ request }: ActionFunctionArgs) {
  await requireAdminApiRequest(request);

  if (request.method.toUpperCase() !== "POST") {
    return json({ error: "Method Not Allowed" }, { status: 405 });
  }

  const [bodyError, body] = await tryCatch(request.json());
  if (bodyError) {
    return json({ error: bodyError.message }, { status: 400 });
  }

  const parsedBody = BodySchema.safeParse(body);
  if (!parsedBody.success) {
    return json({ error: parsedBody.error.message }, { status: 400 });
  }

  const deploymentIds = [...new Set(parsedBody.data.deploymentIds)];
  const results = await new TemplatePrebuildService().requestBuilds({
    deploymentIds,
    force: parsedBody.data.force,
  });

  logger.info("Admin template builds requested", {
    count: deploymentIds.length,
    force: parsedBody.data.force,
    results,
  });

  return json({ results });
}
