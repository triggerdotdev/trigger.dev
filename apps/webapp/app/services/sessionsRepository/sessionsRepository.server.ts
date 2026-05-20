import { type ClickHouse } from "@internal/clickhouse";
import { type Tracer } from "@internal/tracing";
import { type Logger, type LogLevel } from "@trigger.dev/core/logger";
import { type Prisma } from "@trigger.dev/database";
import parseDuration from "parse-duration";
import { z } from "zod";
import { type PrismaClientOrTransaction } from "~/db.server";
import { startActiveSpan } from "~/v3/tracer.server";
import { ClickHouseSessionsRepository } from "./clickhouseSessionsRepository.server";

export type SessionsRepositoryOptions = {
  clickhouse: ClickHouse;
  prisma: PrismaClientOrTransaction;
  logger?: Logger;
  logLevel?: LogLevel;
  tracer?: Tracer;
};

/**
 * Derived status values — `Session` rows don't have a stored status column.
 * `ACTIVE` is the base state; `CLOSED` means `closedAt` is set; `EXPIRED`
 * means `expiresAt` has passed.
 */
export const SessionStatus = z.enum(["ACTIVE", "CLOSED", "EXPIRED"]);
export type SessionStatus = z.infer<typeof SessionStatus>;

const SessionListInputOptionsSchema = z.object({
  organizationId: z.string(),
  projectId: z.string(),
  environmentId: z.string(),
  // filters
  types: z.array(z.string()).optional(),
  tags: z.array(z.string()).optional(),
  taskIdentifiers: z.array(z.string()).optional(),
  externalId: z.string().optional(),
  statuses: z.array(SessionStatus).optional(),
  period: z.string().optional(),
  from: z.number().optional(),
  to: z.number().optional(),
});

export type SessionListInputOptions = z.infer<typeof SessionListInputOptionsSchema>;
export type SessionListInputFilters = Omit<
  SessionListInputOptions,
  "organizationId" | "projectId" | "environmentId"
>;

export type FilterSessionsOptions = Omit<SessionListInputOptions, "period"> & {
  /** period converted to milliseconds duration */
  period: number | undefined;
};

type Pagination = {
  page: {
    size: number;
    cursor?: string;
    direction?: "forward" | "backward";
  };
};

export type ListSessionsOptions = SessionListInputOptions & Pagination;

type OffsetPagination = {
  offset: number;
  limit: number;
};

export type SessionTagListOptions = {
  organizationId: string;
  projectId: string;
  environmentId: string;
  period?: string;
  from?: number;
  to?: number;
  /** Case-insensitive substring match on the tag name */
  query?: string;
} & OffsetPagination;

export type SessionTagList = {
  tags: string[];
};

export type ListedSession = Prisma.SessionGetPayload<{
  select: {
    id: true;
    friendlyId: true;
    externalId: true;
    type: true;
    taskIdentifier: true;
    tags: true;
    metadata: true;
    closedAt: true;
    closedReason: true;
    expiresAt: true;
    createdAt: true;
    updatedAt: true;
    runtimeEnvironmentId: true;
    currentRunId: true;
  };
}>;

export type ISessionsRepository = {
  name: string;
  listSessionIds(options: ListSessionsOptions): Promise<string[]>;
  listSessions(options: ListSessionsOptions): Promise<{
    sessions: ListedSession[];
    pagination: {
      nextCursor: string | null;
      previousCursor: string | null;
    };
  }>;
  countSessions(options: SessionListInputOptions): Promise<number>;
  listTags(options: SessionTagListOptions): Promise<SessionTagList>;
};

export class SessionsRepository implements ISessionsRepository {
  private readonly clickHouseSessionsRepository: ClickHouseSessionsRepository;

  constructor(private readonly options: SessionsRepositoryOptions) {
    this.clickHouseSessionsRepository = new ClickHouseSessionsRepository(options);
  }

  get name() {
    return "sessionsRepository";
  }

  async listSessionIds(options: ListSessionsOptions): Promise<string[]> {
    return startActiveSpan(
      "sessionsRepository.listSessionIds",
      async () => this.clickHouseSessionsRepository.listSessionIds(options),
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

  async listSessions(options: ListSessionsOptions) {
    return startActiveSpan(
      "sessionsRepository.listSessions",
      async () => this.clickHouseSessionsRepository.listSessions(options),
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

  async countSessions(options: SessionListInputOptions) {
    return startActiveSpan(
      "sessionsRepository.countSessions",
      async () => this.clickHouseSessionsRepository.countSessions(options),
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

  async listTags(options: SessionTagListOptions) {
    return startActiveSpan(
      "sessionsRepository.listTags",
      async () => this.clickHouseSessionsRepository.listTags(options),
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

export function parseSessionListInputOptions(data: unknown): SessionListInputOptions {
  return SessionListInputOptionsSchema.parse(data);
}

export function convertSessionListInputOptionsToFilterOptions(
  options: SessionListInputOptions
): FilterSessionsOptions {
  return {
    ...options,
    period: options.period ? parseDuration(options.period) ?? undefined : undefined,
  };
}
