import type { PrismaClient } from "~/db.server";
import { prisma } from "~/db.server";
import { workerQueue } from "../worker.server";
import { z } from "zod";
import {
  RawEventSchema,
  SendEventOptionsSchema,
} from "../../../../../packages/core/src";
import { IngestSendEvent } from "../events/ingestSendEvent.server";

const SendEventOutputSchema = z.object({
  events: z.array(RawEventSchema),
  options: SendEventOptionsSchema.optional(),
});

export class RunFinishedService {
  #prismaClient: PrismaClient;
  #ingestEventService = new IngestSendEvent();

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  public async call(id: string) {
    const run = await this.#prismaClient.jobRun.findUniqueOrThrow({
      where: { id },
      include: {
        environment: {
          include: {
            project: true,
            organization: true,
          },
        },
      },
    });

    // Make sure to start any queued runs once this run is finished
    await workerQueue.enqueue("startQueuedRuns", {
      id: run.queueId,
    });

    if (
      run.status === "SUCCESS" &&
      run.output &&
      typeof run.output === "object" &&
      "events" in run.output
    ) {
      // If the run successfully completes, we will parse the output and
      // if it's in the form of { events: Array<RawEvent> } then we will send the events
      const parsedOutput = SendEventOutputSchema.safeParse(run.output);

      if (parsedOutput.success) {
        for (const newEvent of parsedOutput.data.events) {
          await this.#ingestEventService.call(
            run.environment,
            newEvent,
            parsedOutput.data.options
          );
        }
      }
    }
  }
}
