import type { LoaderArgs } from "@remix-run/server-runtime";
import { json } from "@remix-run/server-runtime";
import { cors } from "remix-utils";
import { z } from "zod";
import { prisma } from "~/db.server";
import { authenticateApiRequest } from "~/services/apiAuth.server";
import { apiCors } from "~/utils/apiCors";
import { taskListToTree } from "~/utils/taskListToTree";

const ParamsSchema = z.object({
  runId: z.string(),
});

const SearchQuerySchema = z.object({
  cursor: z.string().optional(),
  take: z.coerce.number().default(50),
  subtasks: z.coerce.boolean().default(false),
  taskdetails: z.coerce.boolean().default(false),
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

  const { runId } = ParamsSchema.parse(params);

  const url = new URL(request.url);
  const query = SearchQuerySchema.parse(Object.fromEntries(url.searchParams));

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
          params: query.taskdetails,
          output: query.taskdetails,
        },
        where: {
          parentId: query.subtasks ? undefined : null,
        },
        orderBy: {
          id: "asc",
        },
        take: query.take + 1,
        cursor: query.cursor
          ? {
              id: query.cursor,
            }
          : undefined,
      },
    },
  });

  if (!jobRun) {
    return apiCors(
      request,
      json({ message: "Run not found" }, { status: 404 })
    );
  }

  if (jobRun.environmentId !== authenticatedEnv.id) {
    return apiCors(
      request,
      json({ message: "Run not found" }, { status: 404 })
    );
  }

  const selectedTasks = jobRun.tasks.slice(0, query.take);

  const tasks = taskListToTree(selectedTasks, query.subtasks);
  const nextTask = jobRun.tasks[query.take];

  return apiCors(
    request,
    json({
      id: jobRun.id,
      status: jobRun.status,
      startedAt: jobRun.startedAt,
      updatedAt: jobRun.updatedAt,
      completedAt: jobRun.completedAt,
      tasks: tasks.map((task) => {
        const { parentId, ...rest } = task;
        return { ...rest };
      }),
      nextCursor: nextTask ? nextTask.id : undefined,
    })
  );
}
