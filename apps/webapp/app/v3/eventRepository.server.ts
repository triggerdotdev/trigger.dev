import { Prisma, TaskEventStatus, type TaskEventKind } from "@trigger.dev/database";
import { PrismaClient, prisma } from "~/db.server";

export type CreatableEvent = Omit<Prisma.TaskEventCreateInput, "id" | "createdAt">;
export type CreatableEventKind = TaskEventKind;
export type CreatableEventStatus = TaskEventStatus;

export class EventRepository {
  constructor(private db: PrismaClient = prisma) {}

  async insert(event: CreatableEvent) {
    return this.db.taskEvent.create({ data: event });
  }

  async insertMany(events: CreatableEvent[]) {
    return this.db.taskEvent.createMany({ data: events });
  }
}
