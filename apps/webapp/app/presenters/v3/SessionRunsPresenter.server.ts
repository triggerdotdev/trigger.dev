import { RunId } from "@trigger.dev/core/v3/isomorphic";
import type { PrismaClientOrTransaction, TaskRunStatus } from "@trigger.dev/database";
import { z } from "zod";
import {
  countSessionRuns,
  countSessionRunsAtOrBefore,
  decodeSessionRunCursor,
  encodeSessionRunCursor,
  findSessionRunCursor,
  findSessionRunsPage,
  type SessionRunCursor,
  type SessionRunRow,
} from "~/services/realtime/sessionRunPage.server";
import { getRunFinishedAt } from "~/v3/eventRepository/traceInsertedAtBound";
import type { runTraceUnavailableBeforeRead } from "./runTraceSetup.server";
import { startActiveSpan } from "~/v3/tracer.server";

/** Query params, following `GET /api/v1/sessions`. A bad cursor fails the parse (400). */
export const SessionRunsSearchParams = z
  .object({
    "page[size]": z.coerce.number().int().min(1).max(100).default(20),
    "page[after]": z
      .string()
      .transform((value, ctx) => {
        const cursor = decodeSessionRunCursor(value);
        if (!cursor) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Invalid cursor" });
          return z.NEVER;
        }
        return cursor;
      })
      .optional(),
    run: z
      .string()
      .regex(/^run_[a-z0-9]+$/, "Invalid run ID")
      .optional(),
  })
  .refine((value) => !(value["page[after]"] && value.run), {
    message: "Cannot pass both page[after] and run",
    path: ["run"],
  });

export const sessionRunSelect = {
  id: true,
  friendlyId: true,
  projectId: true,
  runtimeEnvironmentId: true,
  status: true,
  createdAt: true,
  startedAt: true,
  completedAt: true,
  updatedAt: true,
  taskEventStore: true,
  logsDeletedAt: true,
} as const;

export type SessionRunRecord = {
  id: string;
  friendlyId: string;
  projectId: string;
  runtimeEnvironmentId: string;
  status: TaskRunStatus;
  createdAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
  updatedAt: Date;
  taskEventStore: string;
  logsDeletedAt: Date | null;
};

type RunTraceUnavailableReason = NonNullable<ReturnType<typeof runTraceUnavailableBeforeRead>>;

type SessionRunItem = {
  number: number;
  friendlyId: string;
  reason: string;
  afterCrash: boolean;
  triggeredAt: string;
  status: TaskRunStatus | null;
  createdAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  finishedAt: string | null;
};

export type SessionRunsPage = {
  data: SessionRunItem[];
  pagination: { next?: string };
  totalCount: number;
  view: Record<string, { unavailable?: RunTraceUnavailableReason }>;
};

export type SessionRunsPresenterDeps = {
  replica: PrismaClientOrTransaction;
  findRunsByIds: (ids: string[]) => Promise<Map<string, SessionRunRecord>>;
  unavailableBeforeRead: typeof runTraceUnavailableBeforeRead;
  emergencySpanCap: number | undefined;
  v1RerouteEnabled: boolean;
};

export type SessionRunsQuery = {
  session: { id: string; projectId: string; runtimeEnvironmentId: string };
  pageSize: number;
  /** Older runs than this cursor. */
  after?: SessionRunCursor;
  /** The page ending at this run, for deep links. */
  runFriendlyId?: string;
  showDeletedLogs: boolean;
};

const CRASH_STATUSES: TaskRunStatus[] = ["CRASHED", "SYSTEM_FAILURE"];

export class SessionRunsPresenter {
  constructor(private readonly deps: SessionRunsPresenterDeps) {}

  /** Null when `runFriendlyId` isn't a run of this session. */
  public call(query: SessionRunsQuery): Promise<SessionRunsPage | null> {
    return startActiveSpan("SessionRunsPresenter.call", (span) => {
      span.setAttribute("session.id", query.session.id);
      span.setAttribute("sessionRuns.pageSize", query.pageSize);
      span.setAttribute("sessionRuns.deepLink", query.runFriendlyId !== undefined);
      return this.#call(query).then((page) => {
        span.setAttribute("sessionRuns.rows", page?.data.length ?? 0);
        return page;
      });
    });
  }

  async #call(query: SessionRunsQuery): Promise<SessionRunsPage | null> {
    const { replica } = this.deps;
    const sessionId = query.session.id;

    const anchor = query.runFriendlyId
      ? await findSessionRunCursor(replica, {
          sessionId,
          runId: RunId.fromFriendlyId(query.runFriendlyId),
        })
      : undefined;
    if (anchor === null) return null;

    const [rows, totalCount] = await Promise.all([
      findSessionRunsPage(replica, {
        sessionId,
        before: query.after,
        atOrBefore: anchor,
        take: query.pageSize + 1,
      }),
      countSessionRuns(replica, { sessionId }),
    ]);

    const pageRows = rows.slice(0, query.pageSize);
    const olderRow = rows.at(query.pageSize);
    const oldestRow = pageRows.at(-1);

    if (!oldestRow) {
      return { data: [], pagination: {}, totalCount, view: {} };
    }

    const [oldestNumber, runsById] = await Promise.all([
      olderRow ? countSessionRunsAtOrBefore(replica, { sessionId, cursor: oldestRow }) : 1,
      this.#findSessionRuns(query.session, rows),
    ]);

    const data = pageRows.map((row, index) => {
      const predecessor = pageRows[index + 1] ?? olderRow;
      return toItem({
        row,
        number: oldestNumber + (pageRows.length - 1 - index),
        run: runsById.get(row.runId),
        predecessorRun: predecessor ? runsById.get(predecessor.runId) : undefined,
      });
    });

    return {
      data,
      pagination: olderRow ? { next: encodeSessionRunCursor(oldestRow) } : {},
      totalCount,
      view: this.#view(pageRows, runsById, query.showDeletedLogs),
    };
  }

  // Runs outside the session's project and environment are treated as missing.
  async #findSessionRuns(
    session: SessionRunsQuery["session"],
    rows: SessionRunRow[]
  ): Promise<Map<string, SessionRunRecord>> {
    const runs = await this.deps.findRunsByIds(rows.map((row) => row.runId));
    const inSession = new Map<string, SessionRunRecord>();
    for (const [id, run] of runs) {
      if (
        run.projectId === session.projectId &&
        run.runtimeEnvironmentId === session.runtimeEnvironmentId
      ) {
        inSession.set(id, run);
      }
    }
    return inSession;
  }

  #view(
    rows: SessionRunRow[],
    runsById: Map<string, SessionRunRecord>,
    showDeletedLogs: boolean
  ): SessionRunsPage["view"] {
    const view: SessionRunsPage["view"] = {};
    for (const row of rows) {
      const run = runsById.get(row.runId);
      if (!run) continue;
      view[run.friendlyId] = {
        unavailable: this.deps.unavailableBeforeRead(run, {
          showDeletedLogs,
          emergencySpanCap: this.deps.emergencySpanCap,
          v1RerouteEnabled: this.deps.v1RerouteEnabled,
        }),
      };
    }
    return view;
  }
}

function toItem({
  row,
  number,
  run,
  predecessorRun,
}: {
  row: SessionRunRow;
  number: number;
  run: SessionRunRecord | undefined;
  predecessorRun: SessionRunRecord | undefined;
}): SessionRunItem {
  return {
    number,
    friendlyId: run?.friendlyId ?? RunId.toFriendlyId(row.runId),
    reason: row.reason,
    afterCrash: predecessorRun ? CRASH_STATUSES.includes(predecessorRun.status) : false,
    triggeredAt: row.triggeredAt.toISOString(),
    status: run?.status ?? null,
    createdAt: run?.createdAt.toISOString() ?? null,
    startedAt: run?.startedAt?.toISOString() ?? null,
    completedAt: run?.completedAt?.toISOString() ?? null,
    finishedAt: (run && getRunFinishedAt(run)?.toISOString()) ?? null,
  };
}
