import type { LoaderArgs } from "@remix-run/server-runtime";
import { json } from "@remix-run/server-runtime";
import { cors } from "remix-utils";
import { z } from "zod";
import { prisma } from "~/db.server";
import { authenticateApiRequest, getApiKeyFromRequest } from "~/services/apiAuth.server";
import { apiCors } from "~/utils/apiCors";
import { taskListToTree } from "~/utils/taskListToTree";

const ParamsSchema = z.object({
  runId: z.string(),
});

const SearchQuerySchema = z.object({
  cursor: z.string().optional(),
  take: z.coerce.number().default(20),
  subtasks: z.coerce.boolean().default(false),
  taskdetails: z.coerce.boolean().default(false),
});

export async function loader({ request, params }: LoaderArgs) {
  if (request.method.toUpperCase() === "OPTIONS") {
    return apiCors(request, json({}));
  }

  const authenticationResult = await authenticateApiRequest(request, {
    allowPublicKey: true,
  });
  if (!authenticationResult) {
    return apiCors(request, json({ error: "Invalid or Missing API key" }, { status: 401 }));
  }

  const authenticatedEnv = authenticationResult.environment;

  const parsed = ParamsSchema.safeParse(params);

  if (!parsed.success) {
    return apiCors(request, json({ error: "Invalid or missing runId" }, { status: 400 }));
  }

  const { runId } = parsed.data;

  const url = new URL(request.url);
  const parsedQuery = SearchQuerySchema.safeParse(Object.fromEntries(url.searchParams));

  if (!parsedQuery.success) {
    return apiCors(
      request,
      json({ error: "Invalid or missing query parameters" }, { status: 400 })
    );
  }

  const query = parsedQuery.data;
  const showTaskDetails = query.taskdetails && authenticationResult.type === "PRIVATE";

  const take = Math.min(query.take, 50);

  const jobRun = await prisma.jobRun.findUnique({
    where: {
      id: runId,
    },
    select: {
      id: true,
      status: true,
      startedAt: true,
      updatedAt: true,
      completedAt: true,
      environmentId: true,
      output: true,
      tasks: {
        select: {
          id: true,
          parentId: true,
          displayKey: true,
          status: true,
          name: true,
          icon: true,
          startedAt: true,
          completedAt: true,
          params: showTaskDetails,
          output: showTaskDetails,
        },
        where: {
          parentId: query.subtasks ? undefined : null,
        },
        orderBy: {
          id: "asc",
        },
        take: take + 1,
        cursor: query.cursor
          ? {
              id: query.cursor,
            }
          : undefined,
      },
    },
  });

  if (!jobRun) {
    return apiCors(request, json({ message: "Run not found" }, { status: 404 }));
  }

  if (jobRun.environmentId !== authenticatedEnv.id) {
    return apiCors(request, json({ message: "Run not found" }, { status: 404 }));
  }

  const selectedTasks = jobRun.tasks.slice(0, take);

  const tasks = taskListToTree(selectedTasks, query.subtasks);
  const nextTask = jobRun.tasks[take];

  return apiCors(
    request,
    json({
      id: jobRun.id,
      status: jobRun.status,
      startedAt: jobRun.startedAt,
      updatedAt: jobRun.updatedAt,
      completedAt: jobRun.completedAt,
      output: jobRun.output,
      tasks: tasks.map((task) => {
        const { parentId, ...rest } = task;
        return { ...rest };
      }),
      nextCursor: nextTask ? nextTask.id : undefined,
    })
  );
}
