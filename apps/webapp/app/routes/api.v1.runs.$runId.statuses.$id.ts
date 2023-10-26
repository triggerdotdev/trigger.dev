import type { ActionFunctionArgs } from "@remix-run/server-runtime";
import { json } from "@remix-run/server-runtime";
import {
  JobRunStatusRecordSchema,
  StatusHistory,
  StatusHistorySchema,
  StatusUpdate,
  StatusUpdateData,
  StatusUpdateSchema,
  StatusUpdateState,
} from "@trigger.dev/core";
import { z } from "zod";
import { $transaction, PrismaClient, prisma } from "~/db.server";
import { authenticateApiRequest } from "~/services/apiAuth.server";
import { logger } from "~/services/logger.server";

const ParamsSchema = z.object({
  runId: z.string(),
  id: z.string(),
});

export async function action({ request, params }: ActionFunctionArgs) {
  // Ensure this is a POST request
  if (request.method.toUpperCase() !== "PUT") {
    return { status: 405, body: "Method Not Allowed" };
  }

  // Next authenticate the request
  const authenticationResult = await authenticateApiRequest(request);

  if (!authenticationResult) {
    return json({ error: "Invalid or Missing API key" }, { status: 401 });
  }

  const { runId, id } = ParamsSchema.parse(params);

  // Now parse the request body
  const anyBody = await request.json();

  logger.debug("SetStatusService.call() request body", {
    body: anyBody,
    runId,
    id,
  });

  const body = StatusUpdateSchema.safeParse(anyBody);

  if (!body.success) {
    return json({ error: "Invalid request body" }, { status: 400 });
  }

  const service = new SetStatusService();

  try {
    const statusRecord = await service.call(runId, id, body.data);

    logger.debug("SetStatusService.call() response body", {
      runId,
      id,
      statusRecord,
    });

    if (!statusRecord) {
      return json({ error: "Something went wrong" }, { status: 500 });
    }

    const status = JobRunStatusRecordSchema.parse({
      ...statusRecord,
      state: statusRecord.state ?? undefined,
      history: statusRecord.history ?? undefined,
      data: statusRecord.data ?? undefined,
    });

    return json(status);
  } catch (error) {
    if (error instanceof Error) {
      return json({ error: error.message }, { status: 400 });
    }

    return json({ error: "Something went wrong" }, { status: 500 });
  }
}

export class SetStatusService {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  public async call(runId: string, id: string, status: StatusUpdate) {
    const statusRecord = await $transaction(this.#prismaClient, async (tx) => {
      const existingStatus = await tx.jobRunStatusRecord.findUnique({
        where: {
          runId_key: {
            runId,
            key: id,
          },
        },
      });

      const history: StatusHistory = [];
      const historyResult = StatusHistorySchema.safeParse(existingStatus?.history);
      if (historyResult.success) {
        history.push(...historyResult.data);
      }
      if (existingStatus) {
        history.push({
          label: existingStatus.label,
          state: (existingStatus.state ?? undefined) as StatusUpdateState,
          data: (existingStatus.data ?? undefined) as StatusUpdateData,
        });
      }

      const updatedStatus = await tx.jobRunStatusRecord.upsert({
        where: {
          runId_key: {
            runId,
            key: id,
          },
        },
        create: {
          key: id,
          runId,
          //this shouldn't ever use the id in reality, as the SDK makess it compulsory on the first call
          label: status.label ?? id,
          state: status.state,
          data: status.data as any,
          history: [],
        },
        update: {
          label: status.label,
          state: status.state,
          data: status.data as any,
          history: history as any[],
        },
      });

      return updatedStatus;
    });

    return statusRecord;
  }
}
