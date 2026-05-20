import { type ClickHouse } from "@internal/clickhouse";
import { type Tracer } from "@internal/tracing";
import { type Logger, type LogLevel } from "@trigger.dev/core/logger";
import { MachinePresetName } from "@trigger.dev/core/v3";
import { BulkActionId, RunId } from "@trigger.dev/core/v3/isomorphic";
import { type Prisma, TaskRunStatus } from "@trigger.dev/database";
import parseDuration from "parse-duration";
import { z } from "zod";
import { timeFilters } from "~/components/runs/v3/SharedFilters";
import { type PrismaClient, type PrismaClientOrTransaction } from "~/db.server";
import { startActiveSpan } from "~/v3/tracer.server";
import { ClickHouseRunsRepository } from "./clickhouseRunsRepository.server";

export type RunsRepositoryOptions = {
  clickhouse: ClickHouse;
  prisma: PrismaClientOrTransaction;
  logger?: Logger;
  logLevel?: LogLevel;
  tracer?: Tracer;
};

const RunStatus = z.enum(Object.values(TaskRunStatus) as [TaskRunStatus, ...TaskRunStatus[]]);

const RunListInputOptionsSchema = z.object({
  organizationId: z.string(),
  projectId: z.string(),
  environmentId: z.string(),
  //filters
  tasks: z.array(z.string()).optional(),
  versions: z.array(z.string()).optional(),
  statuses: z.array(RunStatus).optional(),
  tags: z.array(z.string()).optional(),
  scheduleId: z.string().optional(),
  period: z.string().optional(),
  from: z.number().optional(),
  to: z.number().optional(),
  isTest: z.boolean().optional(),
  rootOnly: z.boolean().optional(),
  batchId: z.string().optional(),
  runId: z.array(z.string()).optional(),
  bulkId: z.string().optional(),
  queues: z.array(z.string()).optional(),
  regions: z.array(z.string()).optional(),
  machines: MachinePresetName.array().optional(),
  errorId: z.string().optional(),
  taskKinds: z.array(z.string()).optional(),
});

export type RunListInputOptions = z.infer<typeof RunListInputOptionsSchema>;
export type RunListInputFilters = Omit<
  RunListInputOptions,
  "organizationId" | "projectId" | "environmentId"
>;

export type ParsedRunFilters = RunListInputFilters & {
  cursor?: string;
  direction?: "forward" | "backward";
  sources?: string[];
};

export type FilterRunsOptions = Omit<RunListInputOptions, "period"> & {
  period: number | undefined;
};

type Pagination = {
  page: {
    size: number;
    cursor?: string;
    direction?: "forward" | "backward";
  };
};

type OffsetPagination = {
  offset: number;
  limit: number;
};

export type ListedRun = Prisma.TaskRunGetPayload<{
  select: {
    id: true;
    friendlyId: true;
    taskIdentifier: true;
    taskVersion: true;
    runtimeEnvironmentId: true;
    status: true;
    createdAt: true;
    startedAt: true;
    lockedAt: true;
    delayUntil: true;
    updatedAt: true;
    completedAt: true;
    isTest: true;
    spanId: true;
    idempotencyKey: true;
    ttl: true;
    expiredAt: true;
    costInCents: true;
    baseCostInCents: true;
    usageDurationMs: true;
    runTags: true;
    depth: true;
    rootTaskRunId: true;
    batchId: true;
    metadata: true;
    metadataType: true;
    machinePreset: true;
    queue: true;
    workerQueue: true;
    annotations: true;
  };
}>;

export type ListRunsOptions = RunListInputOptions & Pagination;

export type TagListOptions = {
  organizationId: string;
  projectId: string;
  environmentId: string;
  period?: string;
  from?: number;
  to?: number;
  /** Performs a case insensitive contains search on the tag name */
  query?: string;
} & OffsetPagination;

export type TagList = {
  tags: string[];
};

export interface IRunsRepository {
  name: string;
  listRunIds(options: ListRunsOptions): Promise<string[]>;
  /** Returns friendly IDs (e.g., run_xxx) instead of internal UUIDs. Used for ClickHouse task_events queries. */
  listFriendlyRunIds(options: ListRunsOptions): Promise<string[]>;
  listRuns(options: ListRunsOptions): Promise<{
    runs: ListedRun[];
    pagination: {
      nextCursor: string | null;
      previousCursor: string | null;
    };
  }>;
  countRuns(options: RunListInputOptions): Promise<number>;
  listTags(options: TagListOptions): Promise<TagList>;
}

export class RunsRepository implements IRunsRepository {
  private readonly clickHouseRunsRepository: ClickHouseRunsRepository;

  constructor(private readonly options: RunsRepositoryOptions) {
    this.clickHouseRunsRepository = new ClickHouseRunsRepository(options);
  }

  get name() {
    return "runsRepository";
  }

  async listRunIds(options: ListRunsOptions): Promise<string[]> {
    return startActiveSpan(
      "runsRepository.listRunIds",
      async () => this.clickHouseRunsRepository.listRunIds(options),
      {
        attributes: {
          "repository.name": "clickhouse",
          organizationId: options.organizationId,
          projectId: options.projectId,
          environmentId: options.environmentId,
        },
      }
    );
  }

  async listFriendlyRunIds(options: ListRunsOptions): Promise<string[]> {
    return startActiveSpan(
      "runsRepository.listFriendlyRunIds",
      async () => this.clickHouseRunsRepository.listFriendlyRunIds(options),
      {
        attributes: {
          "repository.name": "clickhouse",
          organizationId: options.organizationId,
          projectId: options.projectId,
          environmentId: options.environmentId,
        },
      }
    );
  }

  async listRuns(options: ListRunsOptions): Promise<{
    runs: ListedRun[];
    pagination: {
      nextCursor: string | null;
      previousCursor: string | null;
    };
  }> {
    return startActiveSpan(
      "runsRepository.listRuns",
      async () => this.clickHouseRunsRepository.listRuns(options),
      {
        attributes: {
          "repository.name": "clickhouse",
          organizationId: options.organizationId,
          projectId: options.projectId,
          environmentId: options.environmentId,
        },
      }
    );
  }

  async countRuns(options: RunListInputOptions): Promise<number> {
    return startActiveSpan(
      "runsRepository.countRuns",
      async () => this.clickHouseRunsRepository.countRuns(options),
      {
        attributes: {
          "repository.name": "clickhouse",
          organizationId: options.organizationId,
          projectId: options.projectId,
          environmentId: options.environmentId,
        },
      }
    );
  }

  async listTags(options: TagListOptions): Promise<TagList> {
    return startActiveSpan(
      "runsRepository.listTags",
      async () => this.clickHouseRunsRepository.listTags(options),
      {
        attributes: {
          "repository.name": "clickhouse",
          organizationId: options.organizationId,
          projectId: options.projectId,
          environmentId: options.environmentId,
        },
      }
    );
  }
}

export function parseRunListInputOptions(data: any): RunListInputOptions {
  return RunListInputOptionsSchema.parse(data);
}

export async function convertRunListInputOptionsToFilterRunsOptions(
  options: RunListInputOptions,
  prisma: RunsRepositoryOptions["prisma"]
): Promise<FilterRunsOptions> {
  const convertedOptions: FilterRunsOptions = {
    ...options,
    period: undefined,
  };

  // Convert time period to ms
  const time = timeFilters({
    period: options.period,
    from: options.from,
    to: options.to,
  });
  convertedOptions.period = time.period ? parseDuration(time.period) ?? undefined : undefined;

  // Batch friendlyId to id
  if (options.batchId && options.batchId.startsWith("batch_")) {
    const batch = await prisma.batchTaskRun.findFirst({
      select: {
        id: true,
      },
      where: {
        friendlyId: options.batchId,
        runtimeEnvironmentId: options.environmentId,
      },
    });

    if (batch) {
      convertedOptions.batchId = batch.id;
    }
  }

  // ScheduleId can be a friendlyId
  if (options.scheduleId && options.scheduleId.startsWith("sched_")) {
    const schedule = await prisma.taskSchedule.findFirst({
      select: {
        id: true,
      },
      where: {
        friendlyId: options.scheduleId,
        projectId: options.projectId,
      },
    });

    if (schedule) {
      convertedOptions.scheduleId = schedule?.id;
    }
  }

  if (options.bulkId && options.bulkId.startsWith("bulk_")) {
    convertedOptions.bulkId = BulkActionId.toId(options.bulkId);
  }

  if (options.runId) {
    // Convert to friendlyId
    convertedOptions.runId = options.runId.map((r) => RunId.toFriendlyId(r));
  }

  // batchId/runId/scheduleId target specific runs, so rootOnly is meaningless and forced off.
  // tasks is intentionally excluded so rootOnly can narrow a task filter to root runs only.
  if (options.batchId || options.runId?.length || options.scheduleId) {
    convertedOptions.rootOnly = false;
  }

  return convertedOptions;
}
