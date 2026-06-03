import { tool } from "ai";
import { logger } from "@trigger.dev/sdk";
import { isTaskRunStatus, QUEUED_STATUSES, RUNNING_STATUSES } from "~/components/runs/v3/TaskRunStatus";
import { FAILED_RUN_STATUSES } from "~/v3/taskStatus";
import { listRuns as listRunsSchema } from "~/lib/ai-assistant/tool-schemas";
import type { ToolContext } from "../types";

// The LLM passes colloquial statuses ("failed", "running") that aren't real
// TaskRunStatus values, so filtering on them matches nothing. Map those onto
// the canonical groupings the /runs status filter uses, so this stays in sync.
const STATUS_SYNONYMS: Record<string, readonly string[]> = {
  FAILED: FAILED_RUN_STATUSES,
  FAILURE: FAILED_RUN_STATUSES,
  ERROR: FAILED_RUN_STATUSES,
  ERRORED: FAILED_RUN_STATUSES,
  SUCCESS: ["COMPLETED_SUCCESSFULLY"],
  SUCCESSFUL: ["COMPLETED_SUCCESSFULLY"],
  SUCCEEDED: ["COMPLETED_SUCCESSFULLY"],
  COMPLETED: ["COMPLETED_SUCCESSFULLY"],
  RUNNING: RUNNING_STATUSES,
  IN_PROGRESS: RUNNING_STATUSES,
  CANCELLED: ["CANCELED"],
  TIMEOUT: ["TIMED_OUT"],
  QUEUED: QUEUED_STATUSES,
};

function normalizeStatuses(input?: string[]): string[] | undefined {
  if (!input || input.length === 0) return undefined;
  const out = new Set<string>();
  const unrecognized: string[] = [];
  for (const raw of input) {
    const key = raw.trim().toUpperCase().replace(/\s+/g, "_");
    if (isTaskRunStatus(key)) {
      out.add(key);
    } else if (STATUS_SYNONYMS[key]) {
      for (const s of STATUS_SYNONYMS[key]) out.add(s);
    } else {
      // Drop rather than pass through — a bogus status would silently filter
      // out everything (ClickHouse returns zero rows, no error).
      unrecognized.push(raw);
    }
  }
  if (unrecognized.length > 0) {
    logger.warn("listRuns ignored unrecognized status filter values", { unrecognized });
  }
  return out.size > 0 ? Array.from(out) : undefined;
}

function parsePeriod(period: string): { from: number; to: number } {
  const now = Date.now();
  const units: Record<string, number> = {
    m: 60 * 1000,
    h: 60 * 60 * 1000,
    d: 24 * 60 * 60 * 1000,
  };

  const match = period.match(/^(\d+)([mhd])$/);
  if (!match) return { from: now - 86400000, to: now }; // default 24h

  const value = parseInt(match[1], 10);
  const unit = match[2];
  const milliseconds = value * (units[unit] || units.h);

  return { from: now - milliseconds, to: now };
}

export function createListRunsTool(ctx: ToolContext) {
  return tool({
    ...listRunsSchema,
    execute: async (params) => {
      // All imports inside execute() to avoid env.server.ts at CLI indexing time
      const dynamicImport = () => import("~/presenters/v3/NextRunListPresenter.server");

      try {
        const { NextRunListPresenter } = await dynamicImport();
        const { prisma } = await import("~/db.server");
        const { clickhouseFactory } = await import("~/services/clickhouse/clickhouseFactoryInstance.server");

        // Get the environment from context
        const environment = await prisma.runtimeEnvironment.findFirst({
          where: {
            project: { slug: ctx.clientData.projectSlug },
            slug: ctx.clientData.environmentSlug,
          },
          select: {
            id: true,
            organizationId: true,
            project: { select: { id: true } },
          },
        });

        if (!environment) {
          return {
            runs: [],
            total: 0,
            error: "Environment not found",
          };
        }

        const clickhouse = await clickhouseFactory.getClickhouseForOrganization(
          environment.organizationId,
          "standard"
        );
        const presenter = new NextRunListPresenter(prisma, clickhouse);

        // Convert period to ClickHouse time bounds
        const timeFilters = parsePeriod(params.period || "");

        const result = await presenter.call(
          environment.organizationId,
          environment.id,
          {
            projectId: environment.project.id,
            tasks: params.taskIdentifier ? [params.taskIdentifier] : undefined,
            statuses: normalizeStatuses(params.status) as any[] | undefined,
            tags: params.tags,
            from: timeFilters.from,
            to: timeFilters.to,
            pageSize: params.limit || 20,
          }
        );

        // Summarize runs for LLM consumption
        const summarizedRuns = result.runs.map((run: any) => ({
          id: run.friendlyId,
          status: run.status,
          isFinished: run.hasFinished ?? false,
          startedAt: run.startedAt ? new Date(run.startedAt).toISOString() : undefined,
          completedAt: run.finishedAt ? new Date(run.finishedAt).toISOString() : undefined,
          duration:
            run.finishedAt && run.startedAt
              ? `${Math.round((new Date(run.finishedAt).getTime() - new Date(run.startedAt).getTime()) / 1000)}s`
              : undefined,
          parentRunId: (run as any).parentTaskRun?.friendlyId,
          rootRunId: (run as any).rootTaskRun?.friendlyId,
        }));

        return {
          runs: summarizedRuns,
          total: result.pagination?.total || 0,
        };
      } catch (error) {
        return {
          runs: [],
          total: 0,
          error: `Failed to list runs: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    },
  });
}
