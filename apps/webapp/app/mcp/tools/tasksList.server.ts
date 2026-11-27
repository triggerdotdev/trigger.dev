import { boundedIn, TaskRunStatus } from "@trigger.dev/database";
import { z } from "zod";
import { $replica } from "~/db.server";
import { logger } from "~/services/logger.server";
import {
  unifiedTaskListPresenter,
  type HourlyTaskActivity,
  type UnifiedRunningStates,
  type UnifiedTaskListItem,
} from "~/presenters/v3/UnifiedTaskListPresenter.server";
import { findCurrentWorkerFromEnvironment } from "~/v3/models/workerDeployment.server";
import type { McpToolDefinition } from "../registry.server";
import { defineReadTool, resolveToolEnvironment, textResult } from "./define.server";
import { plainError } from "./format/insights";
import { untrusted } from "./format/logFields";
import { startReadBudget } from "./readBudget.server";
import { CommonProjectsInput } from "./schemas/common";

const READ_BUDGET_MS = 10_000;
const PAGE_SIZE = 100;
const STATUSES = new Set<string>(Object.values(TaskRunStatus));
const KINDS: Record<UnifiedTaskListItem["kind"], string> = {
  STANDARD: "standard",
  SCHEDULED: "scheduled",
  AGENT: "agent",
  WEBHOOK: "webhook",
};

const ListTasksInput = CommonProjectsInput.extend({
  page: z
    .number()
    .int()
    .min(1)
    .max(100)
    .describe(`The page to return, ${PAGE_SIZE} tasks per page (default 1)`)
    .optional(),
});

type Details = { description: string | null; exportName: string | null };

/** The tasks on one page of the list. */
const pageOf = <T>(items: T[], page: number) =>
  items.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

function activityLine(slug: string, activity: HourlyTaskActivity | undefined) {
  const buckets = activity?.[slug];
  if (!buckets) return "runs in the last 24 hours: unavailable, the run store could not be read";
  const total = buckets.reduce((sum, bucket) => sum + bucket.total, 0);
  const counts = buckets.flatMap((bucket) =>
    Object.entries(bucket).filter(
      (entry): entry is [string, number] =>
        entry[0] !== "date" && entry[0] !== "total" && typeof entry[1] === "number"
    )
  );
  // Statuses in the order they first appear; there are only a few, so summing each is linear.
  const statuses = [...new Set(counts.map(([status]) => status))];
  const parts = statuses.map((status) => {
    const count = counts.reduce((sum, [s, n]) => (s === status ? sum + n : sum), 0);
    return `${STATUSES.has(status) ? status : untrusted(status, "task-run-status", 64)} ${count}`;
  });
  return `runs in the last 24 hours: ${total}${parts.length ? ` (${parts.join(", ")})` : ""}`;
}

function runningLine(
  item: UnifiedTaskListItem,
  running: UnifiedRunningStates | undefined,
  activityRead: boolean
) {
  if (!running || (item.kind === "AGENT" && !activityRead)) {
    return "running now: unavailable, the run store could not be read";
  }
  const state = running[item.slug];
  if (state?.kind === "agent") {
    return `running now: ${state.running}, suspended: ${state.suspended}`;
  }
  return `running now: ${state?.running ?? 0}`;
}

function renderTask(
  item: UnifiedTaskListItem,
  details: Details | undefined,
  activity: HourlyTaskActivity | undefined,
  running: UnifiedRunningStates | undefined
) {
  return [
    `- ${untrusted(item.slug, "task-slug", 128)}`,
    `  kind: ${KINDS[item.kind]}${item.isSandbox ? " (sandboxed)" : ""}${
      item.agentType ? `, agent type ${untrusted(item.agentType, "task-agent-type", 64)}` : ""
    }`,
    `  file: ${untrusted(item.filePath, "task-file-path", 512)}`,
    `  export: ${details?.exportName ? untrusted(details.exportName, "task-export-name", 128) : "unknown"}`,
    ...(details?.description
      ? [`  description: ${untrusted(details.description, "task-description", 1_000)}`]
      : []),
    `  ${activityLine(item.slug, activity)}`,
    `  ${runningLine(item, running, activity?.[item.slug] !== undefined)}`,
  ];
}

export function createTaskListTools({
  budgetMs = READ_BUDGET_MS,
}: { budgetMs?: number } = {}): McpToolDefinition[] {
  return [
    defineReadTool({
      name: "list_tasks",
      title: "List Tasks",
      description: `List the tasks in an environment's current version, like the Tasks page in the dashboard: each task's ID, kind (standard, scheduled, agent or webhook), file, export name and description, its runs in the last 24 hours by status, and how many are running now. Returns ${PAGE_SIZE} tasks per page.`,
      shape: ListTasksInput.shape,
      auth: { action: "read", subject: "tasks" },
      run: async (input, ctx) => {
        const stopped = (reason: "timeout" | "aborted") =>
          plainError(
            reason === "timeout"
              ? `Reading tasks took longer than ${budgetMs / 1000} seconds and was stopped. Try again.`
              : "The request was cancelled before the tasks were read."
          );
        const budget = startReadBudget(budgetMs, ctx.signal);
        const bounded = budget.read;
        const found = await bounded(() => resolveToolEnvironment(ctx));
        if (!found.ok) return stopped(found.reason);
        const environment = found.value;
        if (!environment) return plainError("Environment not found");

        const listed = await bounded(() =>
          unifiedTaskListPresenter.call({
            organizationId: environment.organizationId,
            projectId: environment.projectId,
            environmentId: environment.id,
            environmentType: environment.type,
            readLimit: budget.limit,
            activityFor: (items) => pageOf(items, input.page ?? 1),
          })
        ).catch((error: unknown) => {
          logger.error("MCP task list tool failed", {
            tool: "list_tasks",
            error:
              error instanceof Error
                ? `${error.name}: ${error.message}`
                : `list_tasks: ${String(error)}`,
          });
          return undefined;
        });
        if (!listed) return plainError("The tool failed. Try again later.");
        if (!listed.ok) return stopped(listed.reason);
        const { items, hourlyActivity, runningStates } = listed.value;
        if (items.length === 0) {
          return textResult(
            `No tasks in ${input.environment}: it has no current version yet. Deploy, or run the dev command for the dev environment.`
          );
        }

        const page = input.page ?? 1;
        const shown = pageOf(items, page);
        const lastPage = Math.ceil(items.length / PAGE_SIZE);
        if (shown.length === 0) {
          return textResult(
            `No tasks on page ${page}: the list has ${lastPage} page${lastPage === 1 ? "" : "s"} (${items.length} tasks in total). Call list_tasks with page ${lastPage} or lower.`
          );
        }
        const slugs = shown.map((item) => item.slug);
        const [details, activity, running] = await Promise.all([
          (async () => {
            const worker = await bounded(() =>
              findCurrentWorkerFromEnvironment(environment, $replica)
            );
            if (!worker.ok || !worker.value) return worker.ok ? { ...worker, value: [] } : worker;
            const workerId = worker.value.id;
            return bounded(() =>
              $replica.backgroundWorkerTask.findMany({
                where: { workerId, slug: { in: boundedIn(slugs) } },
                select: { slug: true, description: true, exportName: true },
              })
            );
          })(),
          bounded(() => hourlyActivity.catch(() => undefined)),
          bounded(() => runningStates.catch(() => undefined)),
        ]);
        if (ctx.signal.aborted) return stopped("aborted");

        const bySlug = new Map((details.ok ? details.value : []).map((d) => [d.slug, d]));
        const lines = [
          `Tasks in ${input.environment}, page ${page} of ${Math.ceil(items.length / PAGE_SIZE)} (${items.length} in total):`,
          ...shown.flatMap((item) =>
            renderTask(
              item,
              bySlug.get(item.slug),
              activity.ok ? activity.value : undefined,
              running.ok ? running.value : undefined
            )
          ),
        ];
        if (!details.ok) lines.push("Export names and descriptions could not be read in time.");
        if (page * PAGE_SIZE < items.length) {
          lines.push(`More tasks exist: call list_tasks with page ${page + 1}.`);
        }
        return textResult(lines.join("\n"));
      },
    }),
  ];
}

export const taskListTools = createTaskListTools();
