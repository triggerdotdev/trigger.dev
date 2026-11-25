import { ScheduleListPresenter } from "~/presenters/v3/ScheduleListPresenter.server";
import { ViewSchedulePresenter } from "~/presenters/v3/ViewSchedulePresenter.server";
import { isBillingConfigured } from "~/services/platform.v3.server";
import { ServiceValidationError } from "~/v3/services/baseService.server";
import type { McpToolContext } from "../gate/types";
import type { McpToolDefinition } from "../registry.server";
import { defineReadTool, resolveToolEnvironment, textResult } from "./define.server";
import { plainError } from "./format/insights";
import { untrusted } from "./format/logFields";
import { scheduleFields, scheduleId, scheduleNotFound } from "./format/schedules";
import { startReadBudget } from "./readBudget.server";
import { ListSchedulesInput, ScheduleIdInput } from "./schemas/schedules";

const READ_BUDGET_MS = 10_000;
const NO_LIMIT = 100_000_000;
const SERVICE_ERROR_CHARS = 2_000;

const interrupted = (reason: "timeout" | "aborted", budgetMs: number) =>
  plainError(
    reason === "timeout"
      ? `Reading schedules took longer than ${budgetMs / 1000} seconds and was stopped. Try again, or narrow the list with tasks or search.`
      : "The request was cancelled before the schedules were read."
  );

function limitLine(used: number, limit: number) {
  if (limit < NO_LIMIT) return `Schedules in use across the project: ${used} of ${limit}.`;
  return isBillingConfigured()
    ? `Schedules in use across the project: ${used}. The plan limit could not be read.`
    : `Schedules in use across the project: ${used}. There is no limit on this server.`;
}

async function withServiceErrors(read: () => Promise<ReturnType<typeof textResult>>) {
  try {
    return await read();
  } catch (error) {
    if (error instanceof ServiceValidationError) {
      return plainError(untrusted(error.message, "schedule-error", SERVICE_ERROR_CHARS));
    }
    throw error;
  }
}

export function createSchedulesTools({
  budgetMs = READ_BUDGET_MS,
}: { budgetMs?: number } = {}): McpToolDefinition[] {
  return [
    defineReadTool({
      name: "list_schedules",
      title: "List Schedules",
      description:
        "List the schedules in an environment, newest first, like the Schedules page in the dashboard: each schedule's task, cron, timezone, window, active state, next run, external ID and deduplication key, and whether it is declarative (defined in code) or imperative. Filter by task, type or text. Also shows how many schedules the project uses of its plan limit.",
      shape: ListSchedulesInput.shape,
      auth: { action: "read", subject: "tasks" },
      run: async (input, ctx: McpToolContext) => {
        const budget = startReadBudget(budgetMs, ctx.signal);
        const found = await budget.read(() => resolveToolEnvironment(ctx));
        if (!found.ok) return interrupted(found.reason, budgetMs);
        const environment = found.value;
        if (!environment) return plainError("Environment not found");
        const page = input.page ?? 1;

        return withServiceErrors(async () => {
          const read = await budget.read(() =>
            new ScheduleListPresenter().call({
              projectId: environment.projectId,
              environmentId: environment.id,
              userId: ctx.identity.userId,
              tasks: input.tasks,
              search: input.search,
              type: input.type,
              page,
              pageSize: input.limit,
              includeLastRun: true,
              includeLastRunFiredAt: true,
            })
          );
          if (!read.ok) return interrupted(read.reason, budgetMs);
          const list = read.value;

          const lines = list.schedules.length
            ? [
                `Schedules in ${input.environment}, page ${list.currentPage} of ${list.totalPages} (${list.totalCount} in total):`,
                ...list.schedules.flatMap((schedule) => [
                  `- ${scheduleId(schedule.friendlyId)}`,
                  ...scheduleFields({
                    ...schedule,
                    nextRun: schedule.active ? schedule.nextRun : undefined,
                    otherEnvironments: schedule.environments.filter((e) => e.id !== environment.id)
                      .length,
                  }).map((field) => `  ${field}`),
                ]),
              ]
            : [
                list.hasFilters
                  ? "No schedules in this environment match these filters."
                  : `No schedules found on page ${page}. Schedules are listed only once the environment has a deployed version or a dev session.`,
              ];
          if (list.currentPage < list.totalPages) {
            lines.push(
              `More schedules exist: call list_schedules with page ${list.currentPage + 1}.`
            );
          }
          lines.push(limitLine(list.limits.used, list.limits.limit));
          return textResult(lines.join("\n"));
        });
      },
    }),
    defineReadTool({
      name: "get_schedule_details",
      title: "Get Schedule Details",
      description:
        "Get one schedule in an environment, like the schedule page in the dashboard: its task, cron with a description, timezone, window, active state, the next 5 runs, external ID, deduplication key, the environments it runs in, and whether it is declarative (defined in code) or imperative. Use list_runs with the schedule ID to see the runs it triggered.",
      shape: ScheduleIdInput.shape,
      auth: { action: "read", subject: "tasks" },
      run: async (input, ctx) => {
        const budget = startReadBudget(budgetMs, ctx.signal);
        const found = await budget.read(() => resolveToolEnvironment(ctx));
        if (!found.ok) return interrupted(found.reason, budgetMs);
        const environment = found.value;
        if (!environment) return plainError("Environment not found");

        const read = await budget.read(() =>
          new ViewSchedulePresenter().call({
            projectId: environment.projectId,
            friendlyId: input.scheduleId,
            environmentId: environment.id,
            userId: ctx.identity.userId,
            includeRunHistory: false,
          })
        );
        if (!read.ok) return interrupted(read.reason, budgetMs);
        const schedule = read.value?.schedule;
        if (!schedule?.instances.some((i) => i.environmentId === environment.id)) {
          return plainError(scheduleNotFound(input.scheduleId));
        }
        const lines = [
          `Schedule ${scheduleId(schedule.friendlyId)}:`,
          ...scheduleFields({
            ...schedule,
            nextRun: undefined,
            otherEnvironments: schedule.instances.filter((i) => i.environmentId !== environment.id)
              .length,
          }),
        ];
        if (schedule.minimumWindowDurationSeconds !== null) {
          lines.push(
            `free-plan minimum spread: ${schedule.minimumWindowDurationSeconds / 60} minutes`
          );
        }
        lines.push(
          schedule.nextRuns.length
            ? "next runs (fire time, then when the run starts):"
            : "next runs: none, the schedule is inactive",
          ...schedule.nextRuns.map(
            (run) => `  - ${run.nominalAt.toISOString()} → ${run.effectiveAt.toISOString()}`
          ),
          `Use list_runs with schedule ${scheduleId(schedule.friendlyId)} to see the runs it triggered.`
        );
        return textResult(lines.join("\n"));
      },
    }),
  ];
}

export const schedulesTools = createSchedulesTools();
