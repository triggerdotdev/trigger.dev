import type { LoaderArgs } from "@remix-run/server-runtime";
import { json } from "@remix-run/server-runtime";
import { z } from "zod";
import { prisma } from "~/db.server";
import {
  authenticateApiRequest,
  getApiKeyFromRequest,
} from "~/services/apiAuth.server";
import { apiCors } from "~/utils/apiCors";

const ParamsSchema = z.object({
  jobSlug: z.string(),
});

const SearchQuerySchema = z.object({
  cursor: z.string().optional(),
  take: z.coerce.number().default(20),
});

export async function loader({ request, params }: LoaderArgs) {
  if (request.method.toUpperCase() === "OPTIONS") {
    return apiCors(request, json({}));
  }

  const authenticatedEnv = await authenticateApiRequest(request, {
    allowPublicKey: true,
  });
  if (!authenticatedEnv) {
    return apiCors(
      request,
      json({ error: "Invalid or Missing API key" }, { status: 401 })
    );
  }

  const { jobSlug } = ParamsSchema.parse(params);

  const url = new URL(request.url);
  const query = SearchQuerySchema.parse(Object.fromEntries(url.searchParams));

  const runs = await prisma.jobRun.findMany({
    where: {
      job: {
        slug: jobSlug,
      },
      projectId: authenticatedEnv.projectId,
    },
    select: {
      id: true,
      status: true,
      startedAt: true,
      updatedAt: true,
      completedAt: true,
      output: true,
    },
    orderBy: {
      id: "desc",
    },
    take: query.take + 1,
    cursor: query.cursor
      ? {
          id: query.cursor,
        }
      : undefined,
  });

  const selectedRuns = runs.slice(0, query.take);
  const nextRun = runs[query.take];

  return apiCors(
    request,
    json({
      runs: selectedRuns,
      nextCursor: nextRun ? nextRun.id : undefined,
    })
  );
}
