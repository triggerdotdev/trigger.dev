import { type Span } from "@opentelemetry/api";
import { type ClickHouse } from "@internal/clickhouse";
import { type PrismaClient, type PrismaClientOrTransaction } from "@trigger.dev/database";
import { type Direction } from "~/components/ListPagination";
import { timeFilters } from "~/components/runs/v3/SharedFilters";
import { findDisplayableEnvironment } from "~/models/runtimeEnvironment.server";
import {
  type SessionStatus,
  SessionsRepository,
} from "~/services/sessionsRepository/sessionsRepository.server";
import { ServiceValidationError } from "~/v3/services/baseService.server";
import { startActiveSpan } from "~/v3/tracer.server";

export type SessionListOptions = {
  userId?: string;
  projectId: string;
  // filters
  types?: string[];
  taskIdentifiers?: string[];
  externalId?: string;
  tags?: string[];
  statuses?: SessionStatus[];
  period?: string;
  from?: number;
  to?: number;
  // pagination
  direction?: Direction;
  cursor?: string;
  pageSize?: number;
};

const DEFAULT_PAGE_SIZE = 25;

export type SessionList = Awaited<ReturnType<SessionListPresenter["call"]>>;
export type SessionListItem = SessionList["sessions"][0];
export type SessionListAppliedFilters = SessionList["filters"];

export class SessionListPresenter {
  constructor(
    private readonly replica: PrismaClientOrTransaction,
    private readonly clickhouse: ClickHouse
  ) {}

  public async call(
    organizationId: string,
    environmentId: string,
    options: SessionListOptions
  ) {
    return startActiveSpan(
      "SessionListPresenter.call",
      (span) => this.#call(organizationId, environmentId, options, span),
      {
        attributes: {
          organizationId,
          environmentId,
          projectId: options.projectId,
        },
      }
    );
  }

  async #call(
    organizationId: string,
    environmentId: string,
    {
      userId,
      projectId,
      types,
      taskIdentifiers,
      externalId,
      tags,
      statuses,
      period,
      from,
      to,
      direction = "forward",
      cursor,
      pageSize = DEFAULT_PAGE_SIZE,
    }: SessionListOptions,
    rootSpan: Span
  ) {
    const time = timeFilters({ period, from, to });

    const hasFilters =
      (types !== undefined && types.length > 0) ||
      (taskIdentifiers !== undefined && taskIdentifiers.length > 0) ||
      (externalId !== undefined && externalId !== "") ||
      (tags !== undefined && tags.length > 0) ||
      (statuses !== undefined && statuses.length > 0) ||
      !time.isDefault;

    rootSpan.setAttribute("filters.hasFilters", hasFilters);
    rootSpan.setAttribute("page.size", pageSize);
    if (cursor) rootSpan.setAttribute("page.cursor", cursor);

    const displayableEnvironment = await startActiveSpan(
      "SessionListPresenter.findDisplayableEnvironment",
      () => findDisplayableEnvironment(environmentId, userId)
    );
    if (!displayableEnvironment) {
      throw new ServiceValidationError("No environment found");
    }

    const sessionsRepository = new SessionsRepository({
      clickhouse: this.clickhouse,
      prisma: this.replica as PrismaClient,
    });

    function clampToNow(date: Date): Date {
      const now = new Date();
      return date > now ? now : date;
    }

    const { sessions, pagination } = await sessionsRepository.listSessions({
      organizationId,
      projectId,
      environmentId,
      types,
      taskIdentifiers,
      externalId,
      tags,
      statuses,
      period,
      from: time.from ? time.from.getTime() : undefined,
      to: time.to ? clampToNow(time.to).getTime() : undefined,
      page: {
        size: pageSize,
        cursor,
        direction,
      },
    });

    rootSpan.setAttribute("page.count", sessions.length);

    let hasAnySessions = sessions.length > 0;
    if (!hasAnySessions) {
      const firstSession = await startActiveSpan(
        "SessionListPresenter.hasAnySessions",
        () =>
          this.replica.session.findFirst({
            where: { runtimeEnvironmentId: environmentId },
            select: { id: true },
          })
      );
      if (firstSession) {
        hasAnySessions = true;
      }
    }

    // Resolve current-run friendlyIds in one query so each row can link to
    // its live run. Status is intentionally not joined yet — that lives in
    // ClickHouse and would mean a second query per page; the link itself
    // is the value most viewers want first.
    const currentRunIds = sessions
      .map((s) => s.currentRunId)
      .filter((id): id is string => Boolean(id));

    const currentRuns = await startActiveSpan(
      "SessionListPresenter.findCurrentRuns",
      async (span) => {
        span.setAttribute("currentRunIds.count", currentRunIds.length);
        return currentRunIds.length > 0
          ? this.replica.taskRun.findMany({
              where: { id: { in: currentRunIds } },
              select: { id: true, friendlyId: true },
            })
          : [];
      }
    );
    const runById = new Map(currentRuns.map((r) => [r.id, r] as const));

    const now = Date.now();

    return {
      sessions: sessions.map((session) => {
        const status: SessionStatus =
          session.closedAt != null
            ? "CLOSED"
            : session.expiresAt != null && session.expiresAt.getTime() < now
              ? "EXPIRED"
              : "ACTIVE";

        const currentRun = session.currentRunId ? runById.get(session.currentRunId) : undefined;

        return {
          id: session.id,
          friendlyId: session.friendlyId,
          externalId: session.externalId,
          type: session.type,
          taskIdentifier: session.taskIdentifier,
          tags: session.tags ? [...session.tags].sort((a, b) => a.localeCompare(b)) : [],
          status,
          closedAt: session.closedAt ? session.closedAt.toISOString() : undefined,
          closedReason: session.closedReason ?? undefined,
          expiresAt: session.expiresAt ? session.expiresAt.toISOString() : undefined,
          createdAt: session.createdAt.toISOString(),
          updatedAt: session.updatedAt.toISOString(),
          environment: displayableEnvironment,
          currentRunFriendlyId: currentRun?.friendlyId,
        };
      }),
      pagination: {
        next: pagination.nextCursor ?? undefined,
        previous: pagination.previousCursor ?? undefined,
      },
      filters: {
        types: types ?? [],
        taskIdentifiers: taskIdentifiers ?? [],
        externalId,
        tags: tags ?? [],
        statuses: statuses ?? [],
        from: time.from,
        to: time.to,
      },
      hasFilters,
      hasAnySessions,
    };
  }
}
