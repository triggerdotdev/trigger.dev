// TaskEventStore.ts
import type { Prisma, TaskEvent } from "@trigger.dev/database";
import type { PrismaClient, PrismaReplicaClient } from "~/db.server";
import { env } from "~/env.server";

export type CommonTaskEvent = Omit<TaskEvent, "id">;
export type TraceEvent = Pick<
  TaskEvent,
  | "spanId"
  | "parentId"
  | "runId"
  | "idempotencyKey"
  | "message"
  | "style"
  | "startTime"
  | "duration"
  | "isError"
  | "isPartial"
  | "isCancelled"
  | "level"
  | "events"
  | "environmentType"
  | "kind"
>;

export type TaskEventStoreTable = "taskEvent" | "taskEventPartitioned";

export function getTaskEventStoreTableForRun(run: {
  taskEventStore?: string;
}): TaskEventStoreTable {
  return run.taskEventStore === "taskEventPartitioned" ? "taskEventPartitioned" : "taskEvent";
}

export function getTaskEventStore(): TaskEventStoreTable {
  return env.TASK_EVENT_PARTITIONING_ENABLED === "1" ? "taskEventPartitioned" : "taskEvent";
}

export class TaskEventStore {
  constructor(private db: PrismaClient, private readReplica: PrismaReplicaClient) {}

  /**
   * Insert one record.
   */
  async create(table: TaskEventStoreTable, data: Prisma.TaskEventCreateInput) {
    if (table === "taskEventPartitioned") {
      return await this.db.taskEventPartitioned.create({ data });
    } else {
      return await this.db.taskEvent.create({ data });
    }
  }

  /**
   * Insert many records.
   */
  async createMany(table: TaskEventStoreTable, data: Prisma.TaskEventCreateManyInput[]) {
    if (table === "taskEventPartitioned") {
      return await this.db.taskEventPartitioned.createMany({ data });
    } else {
      return await this.db.taskEvent.createMany({ data });
    }
  }

  /**
   * Query records. When partitioning is enabled and a startCreatedAt is provided,
   * the store will add a condition on createdAt (from startCreatedAt up to endCreatedAt,
   * which defaults to now).
   *
   * @param where The base Prisma where filter.
   * @param startCreatedAt The start of the createdAt range.
   * @param endCreatedAt Optional end of the createdAt range (defaults to now).
   * @param select Optional select clause.
   */
  async findMany<TSelect extends Prisma.TaskEventSelect>(
    table: TaskEventStoreTable,
    where: Prisma.TaskEventWhereInput,
    startCreatedAt: Date,
    endCreatedAt?: Date,
    select?: TSelect,
    orderBy?: Prisma.TaskEventOrderByWithRelationInput
  ): Promise<Prisma.TaskEventGetPayload<{ select: TSelect }>[]> {
    let finalWhere: Prisma.TaskEventWhereInput = where;

    if (table === "taskEventPartitioned") {
      // Add 1 minute to endCreatedAt to make sure we include all events in the range.
      const end = endCreatedAt
        ? new Date(endCreatedAt.getTime() + env.TASK_EVENT_PARTITIONED_WINDOW_IN_SECONDS * 1000)
        : new Date();

      finalWhere = {
        AND: [
          where,
          {
            createdAt: {
              gte: startCreatedAt,
              lt: end,
            },
          },
        ],
      };
    }

    if (table === "taskEventPartitioned") {
      return (await this.readReplica.taskEventPartitioned.findMany({
        where: finalWhere as Prisma.TaskEventPartitionedWhereInput,
        select,
        orderBy,
      })) as Prisma.TaskEventGetPayload<{ select: TSelect }>[];
    } else {
      // When partitioning is not enabled, we ignore the createdAt range.
      return (await this.readReplica.taskEvent.findMany({
        where,
        select,
        orderBy,
      })) as Prisma.TaskEventGetPayload<{ select: TSelect }>[];
    }
  }

  async findTraceEvents(
    table: TaskEventStoreTable,
    traceId: string,
    startCreatedAt: Date,
    endCreatedAt?: Date
  ) {
    if (table === "taskEventPartitioned") {
      return await this.readReplica.$queryRaw<TraceEvent[]>`
        SELECT
          "spanId",
          "parentId",
          "runId",
          "idempotencyKey",
          LEFT(message, 256) as message,
          style,
          "startTime",
          duration,
          "isError",
          "isPartial",
          "isCancelled",
          level,
          events,
          "environmentType",
          "kind"
        FROM "TaskEventPartitioned"
        WHERE
          "traceId" = ${traceId}
          AND "createdAt" >= ${startCreatedAt.toISOString()}::timestamp
          AND "createdAt" < ${(endCreatedAt
            ? new Date(endCreatedAt.getTime() + env.TASK_EVENT_PARTITIONED_WINDOW_IN_SECONDS * 1000)
            : new Date()
          ).toISOString()}::timestamp
        ORDER BY "startTime" ASC
        LIMIT ${env.MAXIMUM_TRACE_SUMMARY_VIEW_COUNT}
      `;
    } else {
      return await this.readReplica.$queryRaw<TraceEvent[]>`
        SELECT
          id,
          "spanId",
          "parentId",
          "runId",
          "idempotencyKey",
          LEFT(message, 256) as message,
          style,
          "startTime",
          duration,
          "isError",
          "isPartial",
          "isCancelled",
          level,
          events,
          "environmentType",
          "kind"
        FROM "TaskEvent"
        WHERE "traceId" = ${traceId}
        ORDER BY "startTime" ASC
        LIMIT ${env.MAXIMUM_TRACE_SUMMARY_VIEW_COUNT}
      `;
    }
  }
}
