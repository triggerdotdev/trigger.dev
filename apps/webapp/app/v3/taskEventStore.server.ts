// TaskEventStore.ts
import { Prisma, TaskEvent } from "@trigger.dev/database";
import type { PrismaClient, PrismaReplicaClient } from "~/db.server";
import { env } from "~/env.server";
import { clampToEmergencySpanCap } from "~/v3/eventRepository/emergencySpanCap.server";

export type CommonTaskEvent = Omit<TaskEvent, "id">;
export type TraceEvent = Pick<
  TaskEvent,
  | "spanId"
  | "parentId"
  | "runId"
  | "message"
  | "style"
  | "startTime"
  | "duration"
  | "isError"
  | "isPartial"
  | "isCancelled"
  | "level"
  | "events"
  | "kind"
  | "attemptNumber"
>;

export type DetailedTraceEvent = Pick<
  TaskEvent,
  | "spanId"
  | "parentId"
  | "runId"
  | "message"
  | "style"
  | "startTime"
  | "duration"
  | "isError"
  | "isPartial"
  | "isCancelled"
  | "level"
  | "events"
  | "kind"
  | "taskSlug"
  | "properties"
  | "attemptNumber"
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
  constructor(
    private db: PrismaClient,
    private readReplica: PrismaReplicaClient
  ) {}

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
    orderBy?: Prisma.TaskEventOrderByWithRelationInput,
    options?: { includeDebugLogs?: boolean; limit?: number }
  ): Promise<Prisma.TaskEventGetPayload<{ select: TSelect }>[]> {
    let finalWhere: Prisma.TaskEventWhereInput = where;

    if (table === "taskEventPartitioned") {
      // Add buffer to start and end of the range to make sure we include all events in the range.
      const end = endCreatedAt
        ? new Date(endCreatedAt.getTime() + env.TASK_EVENT_PARTITIONED_WINDOW_IN_SECONDS * 1000)
        : new Date();
      const startCreatedAtWithBuffer = new Date(
        startCreatedAt.getTime() - env.TASK_EVENT_PARTITIONED_WINDOW_IN_SECONDS * 1000
      );

      finalWhere = {
        AND: [
          where,
          {
            createdAt: {
              gte: startCreatedAtWithBuffer,
              lt: end,
            },
          },
        ],
      };
    }

    const filterDebug =
      options?.includeDebugLogs === false || options?.includeDebugLogs === undefined;

    if (table === "taskEventPartitioned") {
      return (await this.readReplica.taskEventPartitioned.findMany({
        where: {
          ...(finalWhere as Prisma.TaskEventPartitionedWhereInput),
          ...(filterDebug ? { kind: { not: "LOG" } } : {}),
        },
        select,
        orderBy,
        take: options?.limit,
      })) as Prisma.TaskEventGetPayload<{ select: TSelect }>[];
    } else {
      // When partitioning is not enabled, we ignore the createdAt range.
      return (await this.readReplica.taskEvent.findMany({
        where: {
          ...(finalWhere as Prisma.TaskEventWhereInput),
          ...(filterDebug ? { kind: { not: "LOG" } } : {}),
        },
        select,
        orderBy,
        take: options?.limit,
      })) as Prisma.TaskEventGetPayload<{ select: TSelect }>[];
    }
  }

  async findTraceEvents(
    table: TaskEventStoreTable,
    traceId: string,
    startCreatedAt: Date,
    endCreatedAt?: Date,
    options?: { includeDebugLogs?: boolean }
  ) {
    const filterDebug =
      options?.includeDebugLogs === false || options?.includeDebugLogs === undefined;

    if (table === "taskEventPartitioned") {
      const createdAtBufferInMillis = env.TASK_EVENT_PARTITIONED_WINDOW_IN_SECONDS * 1000;
      const startCreatedAtWithBuffer = new Date(startCreatedAt.getTime() - createdAtBufferInMillis);
      const $endCreatedAt = endCreatedAt ?? new Date();
      const endCreatedAtWithBuffer = new Date($endCreatedAt.getTime() + createdAtBufferInMillis);

      return await this.readReplica.$queryRaw<TraceEvent[]>`
        SELECT
          "spanId",
          "parentId",
          "runId",
          LEFT(message, 256) as message,
          style,
          "startTime",
          duration,
          "isError",
          "isPartial",
          "isCancelled",
          level,
          events,
          "kind",
          "attemptNumber"
        FROM "TaskEventPartitioned"
        WHERE
          "traceId" = ${traceId}
          AND "createdAt" >= ${startCreatedAtWithBuffer.toISOString()}::timestamp
          AND "createdAt" < ${endCreatedAtWithBuffer.toISOString()}::timestamp
          ${
            filterDebug
              ? Prisma.sql`AND \"kind\" <> CAST('LOG'::text AS "public"."TaskEventKind")`
              : Prisma.empty
          }
        ORDER BY "startTime" ASC
        LIMIT ${clampToEmergencySpanCap(env.MAXIMUM_TRACE_SUMMARY_VIEW_COUNT)}
      `;
    } else {
      return await this.readReplica.$queryRaw<TraceEvent[]>`
        SELECT
          id,
          "spanId",
          "parentId",
          "runId",
          LEFT(message, 256) as message,
          style,
          "startTime",
          duration,
          "isError",
          "isPartial",
          "isCancelled",
          level,
          events,
          "kind",
          "attemptNumber"
        FROM "TaskEvent"
        WHERE "traceId" = ${traceId}
          ${
            filterDebug
              ? Prisma.sql`AND \"kind\" <> CAST('LOG'::text AS "public"."TaskEventKind")`
              : Prisma.empty
          }
        ORDER BY "startTime" ASC
        LIMIT ${clampToEmergencySpanCap(env.MAXIMUM_TRACE_SUMMARY_VIEW_COUNT)}
      `;
    }
  }

  async findDetailedTraceEvents(
    table: TaskEventStoreTable,
    traceId: string,
    startCreatedAt: Date,
    endCreatedAt?: Date,
    options?: { includeDebugLogs?: boolean }
  ) {
    const filterDebug =
      options?.includeDebugLogs === false || options?.includeDebugLogs === undefined;

    if (table === "taskEventPartitioned") {
      const createdAtBufferInMillis = env.TASK_EVENT_PARTITIONED_WINDOW_IN_SECONDS * 1000;
      const startCreatedAtWithBuffer = new Date(startCreatedAt.getTime() - createdAtBufferInMillis);
      const $endCreatedAt = endCreatedAt ?? new Date();
      const endCreatedAtWithBuffer = new Date($endCreatedAt.getTime() + createdAtBufferInMillis);

      return await this.readReplica.$queryRaw<DetailedTraceEvent[]>`
        SELECT
          "spanId",
          "parentId",
          "runId",
          message,
          style,
          "startTime",
          duration,
          "isError",
          "isPartial",
          "isCancelled",
          level,
          events,
          "kind",
          "taskSlug",
          properties,
          "attemptNumber"
        FROM "TaskEventPartitioned"
        WHERE
          "traceId" = ${traceId}
          AND "createdAt" >= ${startCreatedAtWithBuffer.toISOString()}::timestamp
          AND "createdAt" < ${endCreatedAtWithBuffer.toISOString()}::timestamp
          ${
            filterDebug
              ? Prisma.sql`AND \"kind\" <> CAST('LOG'::text AS "public"."TaskEventKind")`
              : Prisma.empty
          }
        ORDER BY "startTime" ASC
        LIMIT ${clampToEmergencySpanCap(env.MAXIMUM_TRACE_DETAILED_SUMMARY_VIEW_COUNT)}
      `;
    } else {
      return await this.readReplica.$queryRaw<DetailedTraceEvent[]>`
        SELECT
          "spanId",
          "parentId",
          "runId",
          message,
          style,
          "startTime",
          duration,
          "isError",
          "isPartial",
          "isCancelled",
          level,
          events,
          "kind",
          "taskSlug",
          properties,
          "attemptNumber"
        FROM "TaskEvent"
        WHERE "traceId" = ${traceId}
          ${
            filterDebug
              ? Prisma.sql`AND \"kind\" <> CAST('LOG'::text AS "public"."TaskEventKind")`
              : Prisma.empty
          }
        ORDER BY "startTime" ASC
        LIMIT ${clampToEmergencySpanCap(env.MAXIMUM_TRACE_DETAILED_SUMMARY_VIEW_COUNT)}
      `;
    }
  }

  // Streams a trace's detailed events in (startTime, spanId) order via keyset
  // pagination. Holds at most one page at a time — no overall cap, no full
  // materialisation — so an arbitrarily large trace can be exported with bounded
  // memory. Powers the streaming "Download trace" export.
  async *streamDetailedTraceEvents(
    table: TaskEventStoreTable,
    traceId: string,
    startCreatedAt: Date,
    endCreatedAt?: Date,
    options?: { includeDebugLogs?: boolean; pageSize?: number }
  ): AsyncGenerator<DetailedTraceEvent> {
    const filterDebug =
      options?.includeDebugLogs === false || options?.includeDebugLogs === undefined;
    const pageSize = options?.pageSize ?? 5_000;
    const debugFilter = filterDebug
      ? Prisma.sql`AND \"kind\" <> CAST('LOG'::text AS "public"."TaskEventKind")`
      : Prisma.empty;
    // Spans are written as a partial start-marker plus a completed row; keep
    // only the completed row so the export has one line per span (mirrors the
    // tree path's merge, but without holding state).
    const partialFilter = Prisma.sql`AND "isPartial" = false`;

    const createdAtBufferInMillis = env.TASK_EVENT_PARTITIONED_WINDOW_IN_SECONDS * 1000;
    const startCreatedAtWithBuffer = new Date(startCreatedAt.getTime() - createdAtBufferInMillis);
    const $endCreatedAt = endCreatedAt ?? new Date();
    const endCreatedAtWithBuffer = new Date($endCreatedAt.getTime() + createdAtBufferInMillis);

    let afterStartTime: bigint | null = null;
    let afterSpanId: string | null = null;

    while (true) {
      const keyset: Prisma.Sql =
        afterStartTime === null
          ? Prisma.empty
          : Prisma.sql`AND ("startTime" > ${afterStartTime} OR ("startTime" = ${afterStartTime} AND "spanId" > ${afterSpanId}))`;

      const rows: DetailedTraceEvent[] =
        table === "taskEventPartitioned"
          ? await this.readReplica.$queryRaw<DetailedTraceEvent[]>`
              SELECT "spanId","parentId","runId",message,style,"startTime",duration,"isError","isPartial","isCancelled",level,events,"kind","taskSlug",properties,"attemptNumber"
              FROM "TaskEventPartitioned"
              WHERE "traceId" = ${traceId}
                AND "createdAt" >= ${startCreatedAtWithBuffer.toISOString()}::timestamp
                AND "createdAt" < ${endCreatedAtWithBuffer.toISOString()}::timestamp
                ${debugFilter}
                ${partialFilter}
                ${keyset}
              ORDER BY "startTime" ASC, "spanId" ASC
              LIMIT ${pageSize}
            `
          : await this.readReplica.$queryRaw<DetailedTraceEvent[]>`
              SELECT "spanId","parentId","runId",message,style,"startTime",duration,"isError","isPartial","isCancelled",level,events,"kind","taskSlug",properties,"attemptNumber"
              FROM "TaskEvent"
              WHERE "traceId" = ${traceId}
                ${debugFilter}
                ${partialFilter}
                ${keyset}
              ORDER BY "startTime" ASC, "spanId" ASC
              LIMIT ${pageSize}
            `;

      if (rows.length === 0) {
        break;
      }

      for (const row of rows) {
        yield row;
      }

      if (rows.length < pageSize) {
        break;
      }

      const last: DetailedTraceEvent = rows[rows.length - 1];
      afterStartTime = typeof last.startTime === "bigint" ? last.startTime : BigInt(last.startTime);
      afterSpanId = last.spanId;
    }
  }
}
