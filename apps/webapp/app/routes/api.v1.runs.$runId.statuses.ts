import type { LoaderArgs } from "@remix-run/server-runtime";
import { json } from "@remix-run/server-runtime";
import {
  JobRunStatusRecord,
  StatusHistory,
  StatusHistorySchema,
  StatusUpdate,
  StatusUpdateData,
  StatusUpdateState,
} from "@trigger.dev/core";

import { z } from "zod";
import { $transaction, PrismaClient, prisma } from "~/db.server";
import { authenticateApiRequest } from "~/services/apiAuth.server";
import { logger } from "~/services/logger.server";
import { apiCors } from "~/utils/apiCors";

const ParamsSchema = z.object({
  runId: z.string(),
});

const RecordsSchema = z.array(JobRunStatusRecord);

export async function loader({ request, params }: LoaderArgs) {
  // Next authenticate the request
  const authenticationResult = await authenticateApiRequest(request, { allowPublicKey: true });

  if (!authenticationResult) {
    return json({ error: "Invalid or Missing API key" }, { status: 401 });
  }

  const { runId } = ParamsSchema.parse(params);

  logger.debug("Get run statuses", {
    runId,
  });

  try {
    const statuses = await prisma.jobRunStatusRecord.findMany({
      where: {
        runId,
      },
      orderBy: {
        createdAt: "desc",
      },
    });

    const parsedStatuses = RecordsSchema.parse(statuses);

    return apiCors(
      request,
      json({
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
