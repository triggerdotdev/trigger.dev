import type { ActionFunctionArgs } from "@remix-run/server-runtime";
import { json } from "@remix-run/server-runtime";
import { tryCatch } from "@trigger.dev/core/v3";
import { z } from "zod";
import { $replica, prisma } from "~/db.server";
import { logger } from "~/services/logger.server";
import { requireAdminApiRequest } from "~/services/personalAccessToken.server";
import { backfillVercelExternalIds } from "~/v3/services/vercelExternalIdBackfill.server";

const BodySchema = z.object({
  cursor: z.string().optional(),
  limit: z.number().int().min(1).max(500).default(50),
  recentPerEnvironment: z.number().int().min(0).max(200).default(10),
  parallelism: z.number().int().min(1).max(20).default(5),
  dryRun: z.boolean().default(true),
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

  const { cursor, limit, recentPerEnvironment, parallelism, dryRun } = parsedBody.data;

  logger.info("Vercel external id backfill starting", {
    cursor,
    limit,
    recentPerEnvironment,
    parallelism,
    dryRun,
  });

  const [error, result] = await tryCatch(
    backfillVercelExternalIds({
      prisma,
      replica: $replica,
      cursor,
      limit,
      recentPerEnvironment,
      parallelism,
      dryRun,
    })
  );

  if (error) {
    logger.error("Vercel external id backfill failed", { cursor, error });
    return json({ error: error.message }, { status: 500 });
  }

  logger.info("Vercel external id backfill batch complete", {
    dryRun,
    cursor,
    projectCount: result.projects,
    environmentCount: result.environments.length,
    summary: result.summary,
    deployments: result.deployments,
    next: result.next,
    done: result.done,
  });

  return json(result);
}
