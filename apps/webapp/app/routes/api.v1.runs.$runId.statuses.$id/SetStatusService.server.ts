import { type StatusUpdate , type StatusHistory , StatusHistorySchema , type StatusUpdateState , type StatusUpdateData } from '@trigger.dev/core/schemas';
import { type PrismaClient } from "@trigger.dev/database";
import { prisma, $transaction } from "~/db.server";

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
