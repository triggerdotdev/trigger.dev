import { type ClickhouseQueryBuilder } from "@internal/clickhouse";
import parseDuration from "parse-duration";
import {
  convertSessionListInputOptionsToFilterOptions,
  type FilterSessionsOptions,
  type ISessionsRepository,
  type ListSessionsOptions,
  type SessionListInputOptions,
  type SessionTagListOptions,
  type SessionsRepositoryOptions,
} from "./sessionsRepository.server";

export class ClickHouseSessionsRepository implements ISessionsRepository {
  constructor(private readonly options: SessionsRepositoryOptions) {}

  get name() {
    return "clickhouse";
  }

  async listSessionIds(options: ListSessionsOptions): Promise<string[]> {
    const queryBuilder = this.options.clickhouse.sessions.queryBuilder();
    applySessionFiltersToQueryBuilder(
      queryBuilder,
      convertSessionListInputOptionsToFilterOptions(options)
    );

    if (options.page.cursor) {
      if (options.page.direction === "forward" || !options.page.direction) {
        queryBuilder
          .where("session_id < {sessionId: String}", { sessionId: options.page.cursor })
          .orderBy("created_at DESC, session_id DESC")
          .limit(options.page.size + 1);
      } else {
        queryBuilder
          .where("session_id > {sessionId: String}", { sessionId: options.page.cursor })
          .orderBy("created_at ASC, session_id ASC")
          .limit(options.page.size + 1);
      }
    } else {
      queryBuilder.orderBy("created_at DESC, session_id DESC").limit(options.page.size + 1);
    }

    const [queryError, result] = await queryBuilder.execute();
    if (queryError) throw queryError;

    return result.map((row) => row.session_id);
  }

  async listSessions(options: ListSessionsOptions) {
    const sessionIds = await this.listSessionIds(options);
    const hasMore = sessionIds.length > options.page.size;

    let nextCursor: string | null = null;
    let previousCursor: string | null = null;

    const direction = options.page.direction ?? "forward";
    switch (direction) {
      case "forward": {
        previousCursor = options.page.cursor ? sessionIds.at(0) ?? null : null;
        if (hasMore) {
          nextCursor = sessionIds[options.page.size - 1];
        }
        break;
      }
      case "backward": {
        const reversed = [...sessionIds].reverse();
        if (hasMore) {
          previousCursor = reversed.at(1) ?? null;
          nextCursor = reversed.at(options.page.size) ?? null;
        } else {
          nextCursor = reversed.at(options.page.size - 1) ?? null;
        }
        break;
      }
    }

    const idsToReturn =
      options.page.direction === "backward" && hasMore
        ? sessionIds.slice(1, options.page.size + 1)
        : sessionIds.slice(0, options.page.size);

    let sessions = await this.options.prisma.session.findMany({
      where: {
        id: { in: idsToReturn },
        runtimeEnvironmentId: options.environmentId,
      },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        friendlyId: true,
        externalId: true,
        type: true,
        taskIdentifier: true,
        tags: true,
        metadata: true,
        closedAt: true,
        closedReason: true,
        expiresAt: true,
        createdAt: true,
        updatedAt: true,
        runtimeEnvironmentId: true,
      },
    });

    // ClickHouse is slightly delayed; narrow by derived status in-memory to
    // catch recent Postgres writes that haven't replicated yet.
    if (options.statuses && options.statuses.length > 0) {
      const wanted = new Set(options.statuses);
      const now = Date.now();
      sessions = sessions.filter((s) => {
        const status =
          s.closedAt != null
            ? "CLOSED"
            : s.expiresAt != null && s.expiresAt.getTime() < now
              ? "EXPIRED"
              : "ACTIVE";
        return wanted.has(status);
      });
    }

    return {
      sessions,
      pagination: { nextCursor, previousCursor },
    };
  }

  async countSessions(options: SessionListInputOptions): Promise<number> {
    const queryBuilder = this.options.clickhouse.sessions.countQueryBuilder();
    applySessionFiltersToQueryBuilder(
      queryBuilder,
      convertSessionListInputOptionsToFilterOptions(options)
    );

    const [queryError, result] = await queryBuilder.execute();
    if (queryError) throw queryError;

    if (result.length === 0) {
      throw new Error("No count rows returned");
    }
    return result[0].count;
  }

  async listTags(options: SessionTagListOptions) {
    const queryBuilder = this.options.clickhouse.sessions
      .tagQueryBuilder()
      .where("organization_id = {organizationId: String}", {
        organizationId: options.organizationId,
      })
      .where("project_id = {projectId: String}", { projectId: options.projectId })
      .where("environment_id = {environmentId: String}", {
        environmentId: options.environmentId,
      });

    const periodMs = options.period ? parseDuration(options.period) ?? undefined : undefined;
    if (periodMs) {
      queryBuilder.where("created_at >= fromUnixTimestamp64Milli({period: Int64})", {
        period: new Date(Date.now() - periodMs).getTime(),
      });
    }

    if (options.from) {
      queryBuilder.where("created_at >= fromUnixTimestamp64Milli({from: Int64})", {
        from: options.from,
      });
    }

    if (options.to) {
      queryBuilder.where("created_at <= fromUnixTimestamp64Milli({to: Int64})", {
        to: options.to,
      });
    }

    if (options.query && options.query.trim().length > 0) {
      queryBuilder.where("positionCaseInsensitiveUTF8(tag, {query: String}) > 0", {
        query: options.query,
      });
    }

    queryBuilder.orderBy("tag ASC").limit(options.limit);

    const [queryError, result] = await queryBuilder.execute();
    if (queryError) throw queryError;

    return { tags: result.map((row) => row.tag) };
  }
}

function applySessionFiltersToQueryBuilder<T>(
  queryBuilder: ClickhouseQueryBuilder<T>,
  options: FilterSessionsOptions
) {
  queryBuilder
    .where("organization_id = {organizationId: String}", {
      organizationId: options.organizationId,
    })
    .where("project_id = {projectId: String}", { projectId: options.projectId })
    .where("environment_id = {environmentId: String}", { environmentId: options.environmentId });

  if (options.types && options.types.length > 0) {
    queryBuilder.where("type IN {types: Array(String)}", { types: options.types });
  }

  if (options.tags && options.tags.length > 0) {
    queryBuilder.where("hasAny(tags, {tags: Array(String)})", { tags: options.tags });
  }

  if (options.taskIdentifiers && options.taskIdentifiers.length > 0) {
    queryBuilder.where("task_identifier IN {taskIdentifiers: Array(String)}", {
      taskIdentifiers: options.taskIdentifiers,
    });
  }

  if (options.externalId) {
    queryBuilder.where("external_id = {externalId: String}", { externalId: options.externalId });
  }

  if (options.statuses && options.statuses.length > 0) {
    const conditions: string[] = [];
    if (options.statuses.includes("ACTIVE")) {
      conditions.push(
        "(closed_at IS NULL AND (expires_at IS NULL OR expires_at > now64(3)))"
      );
    }
    if (options.statuses.includes("CLOSED")) {
      conditions.push("closed_at IS NOT NULL");
    }
    if (options.statuses.includes("EXPIRED")) {
      conditions.push("(closed_at IS NULL AND expires_at IS NOT NULL AND expires_at <= now64(3))");
    }
    if (conditions.length > 0) {
      queryBuilder.where(`(${conditions.join(" OR ")})`);
    }
  }

  if (options.period) {
    queryBuilder.where("created_at >= fromUnixTimestamp64Milli({period: Int64})", {
      period: new Date(Date.now() - options.period).getTime(),
    });
  }

  if (options.from) {
    queryBuilder.where("created_at >= fromUnixTimestamp64Milli({from: Int64})", {
      from: options.from,
    });
  }

  if (options.to) {
    queryBuilder.where("created_at <= fromUnixTimestamp64Milli({to: Int64})", {
      to: options.to,
    });
  }
}
