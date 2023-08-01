import type { LoaderArgs } from "@remix-run/server-runtime";
import { json } from "@remix-run/server-runtime";
import { z } from "zod";
import { prisma } from "~/db.server";
import { authenticateApiRequest } from "~/services/apiAuth.server";
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

  const authenticationResult = await authenticateApiRequest(request);
  if (!authenticationResult) {
    return apiCors(request, json({ error: "Invalid or Missing API key" }, { status: 401 }));
  }

  const authenticatedEnv = authenticationResult.environment;

  const parsedParams = ParamsSchema.safeParse(params);

  if (!parsedParams.success) {
    return apiCors(request, json({ error: "Missing the job id" }, { status: 400 }));
  }

  const { jobSlug } = parsedParams.data;

  const url = new URL(request.url);
  const parsedQuery = SearchQuerySchema.safeParse(Object.fromEntries(url.searchParams));

  if (!parsedQuery.success) {
    return apiCors(
      request,
      json({ error: "Invalid or missing query parameters" }, { status: 400 })
    );
  }

  const query = parsedQuery.data;
  const take = Math.min(query.take, 50);

  const runs = await prisma.jobRun.findMany({
    where: {
      job: {
        slug: jobSlug,
      },
      environmentId: authenticatedEnv.id,
      projectId: authenticatedEnv.projectId,
    },
    select: {
      id: true,
      status: true,
      startedAt: true,
      updatedAt: true,
      completedAt: true,
    },
    orderBy: {
      id: "desc",
    },
    take: take + 1,
    cursor: query.cursor
      ? {
          id: query.cursor,
        }
      : undefined,
  });

  const selectedRuns = runs.slice(0, take);
  const nextRun = runs[take];

  return apiCors(
    request,
    json({
      runs: selectedRuns,
      nextCursor: nextRun ? nextRun.id : undefined,
    })
  );
}
