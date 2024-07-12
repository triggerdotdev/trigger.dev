import { type PrismaClient, type PrismaClientOrTransaction, prisma } from "~/db.server";
import { taskOperationWorker } from "../worker.server";
import { EphemeralDispatchableSchema } from "~/models/eventDispatcher.server";
import { ExpireDispatcherService } from "./expireDispatcher.server";

export class InvokeEphemeralDispatcherService {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  public async call(id: string, eventRecordId: string) {
    const eventDispatcher = await this.#prismaClient.eventDispatcher.findUnique({
      where: {
        id,
      },
    });

    if (!eventDispatcher) {
      return;
    }

    if (!eventDispatcher.enabled) {
      return;
    }

    const eventRecord = await this.#prismaClient.eventRecord.findUnique({
      where: {
        id: eventRecordId,
      },
      include: {
        externalAccount: true,
      },
    });

    if (!eventRecord) {
      return;
    }

    if (eventRecord.cancelledAt) {
      return;
    }

    const dispatchable = EphemeralDispatchableSchema.safeParse(eventDispatcher.dispatchable);

    if (!dispatchable.success) {
      return;
    }

    const url = dispatchable.data.url;

    const body = {
      id: eventRecord.eventId,
      source: eventRecord.source,
      name: eventRecord.name,
      payload: eventRecord.payload,
      context: eventRecord.context,
      timestamp: eventRecord.timestamp,
      accountId: eventRecord.externalAccount ? eventRecord.externalAccount.identifier : undefined,
    };

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=utf-8",
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      throw new Error(
        `Failed to invoke ephemeral dispatcher: ${response.statusText} [${response.status}]`
      );
    }

    // Run the expire dispatcher service
    await ExpireDispatcherService.enqueue(id, 0);
  }

  static async dequeue(id: string, tx?: PrismaClientOrTransaction) {
    await taskOperationWorker.dequeue(`invoke:ephemeral:${id}`, { tx });
  }

  static async enqueue(id: string, eventRecordId: string, tx?: PrismaClientOrTransaction) {
    await taskOperationWorker.enqueue(
      "invokeEphemeralDispatcher",
      {
        id,
        eventRecordId,
      },
      {
        tx,
        jobKey: `invoke:ephemeral:${id}`,
      }
    );
  }
}
