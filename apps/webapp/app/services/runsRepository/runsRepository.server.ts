import { type ClickHouse, type ClickhouseQueryBuilder } from "@internal/clickhouse";
import { type Tracer } from "@internal/tracing";
import { type Logger, type LogLevel } from "@trigger.dev/core/logger";
import { MachinePresetName } from "@trigger.dev/core/v3";
import { BulkActionId, RunId } from "@trigger.dev/core/v3/isomorphic";
import { Prisma, TaskRunStatus } from "@trigger.dev/database";
import parseDuration from "parse-duration";
import { z } from "zod";
import { timeFilters } from "~/components/runs/v3/SharedFilters";
import { type PrismaClient } from "~/db.server";
import { ClickHouseRunsRepository } from "./clickhouseRunsRepository.server";

export type RunsRepositoryOptions = {
  clickhouse: ClickHouse;
  prisma: PrismaClient;
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

type ListedRun = Prisma.TaskRunGetPayload<{
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

export interface IRunsRepository {
  listRunIds(options: ListRunsOptions): Promise<string[]>;
  listRuns(options: ListRunsOptions): Promise<{
    runs: ListedRun[];
    pagination: {
      nextCursor: string | null;
      previousCursor: string | null;
    };
  }>;
  countRuns(options: RunListInputOptions): Promise<number>;
}

export class RunsRepository implements IRunsRepository {
  private readonly clickHouseRunsRepository: ClickHouseRunsRepository;
  constructor(private readonly options: RunsRepositoryOptions) {
    this.clickHouseRunsRepository = new ClickHouseRunsRepository(options);
  }

  listRunIds(options: ListRunsOptions): Promise<string[]> {
    return this.clickHouseRunsRepository.listRunIds(options);
  }

  listRuns(options: ListRunsOptions): Promise<{
    runs: ListedRun[];
    pagination: {
      nextCursor: string | null;
      previousCursor: string | null;
    };
  }> {
    return this.clickHouseRunsRepository.listRuns(options);
  }

  countRuns(options: RunListInputOptions): Promise<number> {
    return this.clickHouseRunsRepository.countRuns(options);
  }
}

export function parseRunListInputOptions(data: any): RunListInputOptions {
  return RunListInputOptionsSchema.parse(data);
}
