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
import { FEATURE_FLAG, makeFlag } from "~/v3/featureFlags.server";
import { startActiveSpan } from "~/v3/tracer.server";
import { logger } from "../logger.server";
import { ClickHouseRunsRepository } from "./clickhouseRunsRepository.server";
import { PostgresRunsRepository } from "./postgresRunsRepository.server";

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
  machines: MachinePresetName.array().optional(),
});

export type RunListInputOptions = z.infer<typeof RunListInputOptionsSchema>;
export type RunListInputFilters = Omit<
  RunListInputOptions,
  "organizationId" | "projectId" | "environmentId"
>;

export type ParsedRunFilters = RunListInputFilters & {
  cursor?: string;
  direction?: "forward" | "backward";
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
  private readonly postgresRunsRepository: PostgresRunsRepository;
  private readonly defaultRepository: "clickhouse" | "postgres";
  private readonly logger: Logger;

  constructor(
    private readonly options: RunsRepositoryOptions & {
      defaultRepository?: "clickhouse" | "postgres";
    }
  ) {
    this.clickHouseRunsRepository = new ClickHouseRunsRepository(options);
    this.postgresRunsRepository = new PostgresRunsRepository(options);
    this.defaultRepository = options.defaultRepository ?? "clickhouse";
    this.logger = options.logger ?? logger;
  }

  get name() {
    return "runsRepository";
  }

  async #getRepository(): Promise<IRunsRepository> {
    return startActiveSpan("runsRepository.getRepository", async (span) => {
      const getFlag = makeFlag(this.options.prisma);
      const runsListRepository = await getFlag({
        key: FEATURE_FLAG.runsListRepository,
        defaultValue: this.defaultRepository,
      });

      span.setAttribute("repository.name", runsListRepository);

      logger.log("runsListRepository", { runsListRepository });

      switch (runsListRepository) {
        case "postgres":
          return this.postgresRunsRepository;
        case "clickhouse":
        default:
          return this.clickHouseRunsRepository;
      }
    });
  }

  async listRunIds(options: ListRunsOptions): Promise<string[]> {
    const repository = await this.#getRepository();
    return startActiveSpan(
      "runsRepository.listRunIds",
      async () => {
        try {
          return await repository.listRunIds(options);
        } catch (error) {
          // If ClickHouse fails, retry with Postgres
          if (repository.name === "clickhouse") {
            this.logger?.warn("ClickHouse failed, retrying with Postgres", { error });
            return startActiveSpan(
              "runsRepository.listRunIds.fallback",
              async () => {
                return await this.postgresRunsRepository.listRunIds(options);
              },
              {
                attributes: {
                  "repository.name": "postgres",
                  "fallback.reason": "clickhouse_error",
                  "fallback.error": error instanceof Error ? error.message : String(error),
                  organizationId: options.organizationId,
                  projectId: options.projectId,
                  environmentId: options.environmentId,
                },
              }
            );
          }
          throw error;
        }
      },
      {
        attributes: {
          "repository.name": repository.name,
          organizationId: options.organizationId,
          projectId: options.projectId,
          environmentId: options.environmentId,
        },
      }
    );
  }

  async listFriendlyRunIds(options: ListRunsOptions): Promise<string[]> {
    const repository = await this.#getRepository();
    return startActiveSpan(
      "runsRepository.listFriendlyRunIds",
      async () => {
        try {
          return await repository.listFriendlyRunIds(options);
        } catch (error) {
          // If ClickHouse fails, retry with Postgres
          if (repository.name === "clickhouse") {
            this.logger?.warn("ClickHouse failed, retrying with Postgres", { error });
            return startActiveSpan(
              "runsRepository.listFriendlyRunIds.fallback",
              async () => {
                return await this.postgresRunsRepository.listFriendlyRunIds(options);
              },
              {
                attributes: {
                  "repository.name": "postgres",
                  "fallback.reason": "clickhouse_error",
                  "fallback.error": error instanceof Error ? error.message : String(error),
                  organizationId: options.organizationId,
                  projectId: options.projectId,
                  environmentId: options.environmentId,
                },
              }
            );
          }
          throw error;
        }
      },
      {
        attributes: {
          "repository.name": repository.name,
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
    const repository = await this.#getRepository();
    return startActiveSpan(
      "runsRepository.listRuns",
      async () => {
        try {
          return await repository.listRuns(options);
        } catch (error) {
          // If ClickHouse fails, retry with Postgres
          if (repository.name === "clickhouse") {
            this.logger?.warn("ClickHouse failed, retrying with Postgres", { error });
            return startActiveSpan(
              "runsRepository.listRuns.fallback",
              async () => {
                return await this.postgresRunsRepository.listRuns(options);
              },
              {
                attributes: {
                  "repository.name": "postgres",
                  "fallback.reason": "clickhouse_error",
                  "fallback.error": error instanceof Error ? error.message : String(error),
                  organizationId: options.organizationId,
                  projectId: options.projectId,
                  environmentId: options.environmentId,
                },
              }
            );
          }
          throw error;
        }
      },
      {
        attributes: {
          "repository.name": repository.name,
          organizationId: options.organizationId,
          projectId: options.projectId,
          environmentId: options.environmentId,
        },
      }
    );
  }

  async countRuns(options: RunListInputOptions): Promise<number> {
    const repository = await this.#getRepository();
    return startActiveSpan(
      "runsRepository.countRuns",
      async () => {
        try {
          return await repository.countRuns(options);
        } catch (error) {
          // If ClickHouse fails, retry with Postgres
          if (repository.name === "clickhouse") {
            this.logger?.warn("ClickHouse failed, retrying with Postgres", { error });
            return startActiveSpan(
              "runsRepository.countRuns.fallback",
              async () => {
                return await this.postgresRunsRepository.countRuns(options);
              },
              {
                attributes: {
                  "repository.name": "postgres",
                  "fallback.reason": "clickhouse_error",
                  "fallback.error": error instanceof Error ? error.message : String(error),
                  organizationId: options.organizationId,
                  projectId: options.projectId,
                  environmentId: options.environmentId,
                },
              }
            );
          }
          throw error;
        }
      },
      {
        attributes: {
          "repository.name": repository.name,
          organizationId: options.organizationId,
          projectId: options.projectId,
          environmentId: options.environmentId,
        },
      }
    );
  }

  async listTags(options: TagListOptions): Promise<TagList> {
    const repository = await this.#getRepository();
    return startActiveSpan(
      "runsRepository.listTags",
      async () => {
        return await repository.listTags(options);
      },
      {
        attributes: {
          "repository.name": repository.name,
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

  // Show all runs if we are filtering by batchId or runId
  if (options.batchId || options.runId?.length || options.scheduleId || options.tasks?.length) {
    convertedOptions.rootOnly = false;
  }

  return convertedOptions;
}
