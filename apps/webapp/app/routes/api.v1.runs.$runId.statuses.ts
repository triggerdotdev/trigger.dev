import type { LoaderFunctionArgs } from "@remix-run/server-runtime";
import { json } from "@remix-run/server-runtime";
import { JobRunStatusRecordSchema } from "@trigger.dev/core";
import { z } from "zod";
import { prisma } from "~/db.server";
import { authenticateApiRequest } from "~/services/apiAuth.server";
import { logger } from "~/services/logger.server";
import { apiCors } from "~/utils/apiCors";

const ParamsSchema = z.object({
  runId: z.string(),
});

const RecordsSchema = z.array(JobRunStatusRecordSchema);

export async function loader({ request, params }: LoaderFunctionArgs) {
  if (request.method.toUpperCase() === "OPTIONS") {
    return apiCors(request, json({}));
  }

  // Next authenticate the request
  const authenticationResult = await authenticateApiRequest(request, { allowPublicKey: true });

  if (!authenticationResult) {
    return apiCors(request, json({ error: "Invalid or Missing API key" }, { status: 401 }));
  }

  const { runId } = ParamsSchema.parse(params);

  logger.debug("Get run statuses", {
    runId,
  });

  try {
    const run = await prisma.jobRun.findUnique({
      where: {
        id: runId,
      },
      select: {
        id: true,
        status: true,
        output: true,
        statuses: {
          orderBy: {
            createdAt: "asc",
          },
        },
      },
    });

    if (!run) {
      return apiCors(request, json({ error: `No run found for id ${runId}` }, { status: 404 }));
    }

    const parsedStatuses = RecordsSchema.parse(
      run.statuses.map((s) => ({
        ...s,
        state: s.state ?? undefined,
        data: s.data ?? undefined,
        history: s.history ?? undefined,
      }))
    );

    return apiCors(
      request,
      json({
        run: {
          id: run.id,
          status: run.status,
          output: run.output,
        },
        statuses: parsedStatuses,
      })
    );
  } catch (error) {
    if (error instanceof Error) {
      return apiCors(request, json({ error: error.message }, { status: 400 }));
    }

    return apiCors(request, json({ error: "Something went wrong" }, { status: 500 }));
  }
}
