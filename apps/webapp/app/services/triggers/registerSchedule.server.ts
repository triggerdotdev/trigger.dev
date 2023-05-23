import type { RegisterSchedulePayload } from "@trigger.dev/internal";
import type { PrismaClient } from "~/db.server";
import { prisma } from "~/db.server";

export class RegisterScheduleService {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  public async call(endpointId: string, metadata: RegisterSchedulePayload) {
    // Create an eventDispatcher where the payloadFilter is { id: [metadata.id] }
    // event.name is scheduled
    // the dispatchable will be type: "SCHEDULE", id: schedule.id
    // so when the schedule worker job runs, it will emit an event with { name: "scheduled", payload: { id: schedule.id, ts: new Date(), lastTimestamp: lastEvent.ts } }
    // Now we need to use the metadata to create some kind of recurring scheduly thingy (a schedulesource?)
  }
}
