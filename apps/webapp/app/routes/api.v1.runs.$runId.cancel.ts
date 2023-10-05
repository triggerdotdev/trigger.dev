// use CancelRunService to write a new route handler for the /api/v1/runs/:runId/cancel endpoint
import { parse } from "@conform-to/zod";
import { ActionFunction, json } from "@remix-run/node";
import { z } from "zod";
import { prisma } from "~/db.server";
import { redirectWithSuccessMessage } from "~/models/message.server";
import { authenticateApiRequest } from "~/services/apiAuth.server";
import { apiCors } from "~/utils/apiCors";
import { logger } from "~/services/logger.server";
import { CancelRunService } from "~/services/runs/cancelRun.server";
import { taskListToTree } from "~/utils/taskListToTree";

const ParamSchema = z.object({
    runId: z.string(),
});

const SearchQuerySchema = z.object({
    cursor: z.string().optional(),
    take: z.coerce.number().default(20),
    subtasks: z.coerce.boolean().default(false),
    taskdetails: z.coerce.boolean().default(false),
});

export const action: ActionFunction = async ({ request, params }) => {
    // Ensure this is a POST request
    if (request.method.toUpperCase() != "POST") {
        return { status: 405, body: "Method Not Allowed" };
    }

    const authenticationResult = await authenticateApiRequest(request, {
        allowPublicKey: true,
    });
    if (!authenticationResult) {
        return apiCors(request, json({ error: "Invalid or Missing API key" }, { status: 401 }));
    }

    const { runId } = ParamSchema.parse(params);
    const url = new URL(request.url);

    const cancelRunService = new CancelRunService();
    const authenticatedEnv = authenticationResult.environment;
    const parsedQuery = SearchQuerySchema.safeParse(Object.fromEntries(url.searchParams));

    if (!parsedQuery.success) {
        return apiCors(
            request,
            json({ error: "Invalid or missing query parameters" }, { status: 400 })
        );
    }

    try {
        const query = parsedQuery.data;
        const take = Math.min(query.take, 50);
        const showTaskDetails = query.taskdetails && authenticationResult.type === "PRIVATE";
        await cancelRunService.call({ runId });
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
                statuses: {
                    select: { key: true, label: true, state: true, data: true, history: true },
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

        return apiCors(request, json({
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
            statuses: jobRun.statuses.map((s) => ({
                ...s,
                state: s.state ?? undefined,
                data: s.data ?? undefined,
                history: s.history ?? undefined,
            })),
            nextCursor: nextTask ? nextTask.id : undefined,
        }));
    } catch (error) {
        if (error instanceof Error) {
            logger.error("Failed to cancel run", {
                error: {
                    name: error.name,
                    message: error.message,
                    stack: error.stack,
                },
            });
            return apiCors(request, json({ errors: { body: error.message } }, { status: 500 }));
        } else {
            logger.error("Failed to cancel run", { error });
            return apiCors(request, json({ errors: { body: "Unknown error" } }, { status: 500 }));
        }
    }
};