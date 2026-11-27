import parse from "parse-duration";
import { $replica } from "~/db.server";
import { storedQueueName } from "~/components/queues/queue-name";
import {
  clampQueueMetricsPeriod,
  clipQueueMetricsWindow,
  QUEUE_METRICS_DEFAULT_PERIOD,
} from "~/components/queues/queueMetricsPeriod";
import { queueMetricsMaxPeriodDays } from "~/components/queues/queueMetricsPeriod.server";
import { EnvironmentQueuePresenter } from "~/presenters/v3/EnvironmentQueuePresenter.server";
import { LimitsPresenter } from "~/presenters/v3/LimitsPresenter.server";
import { QueueAllocationPresenter } from "~/presenters/v3/QueueAllocationPresenter.server";
import { QueueListPresenter } from "~/presenters/v3/QueueListPresenter.server";
import { QueueMetricsPresenter } from "~/presenters/v3/QueueMetricsPresenter.server";
import { QueueRetrievePresenter } from "~/presenters/v3/QueueRetrievePresenter.server";
import type { AuthenticatedEnvironment } from "~/services/apiAuth.server";
import { logger } from "~/services/logger.server";
import { canAccessQueueMetricsUi } from "~/v3/canAccessQueueMetricsUi.server";
import { engine } from "~/v3/runEngine.server";
import type { McpToolContext } from "../gate/types";
import type { McpToolDefinition } from "../registry.server";
import { defineReadTool, resolveToolEnvironment, textResult } from "./define.server";
import { plainError } from "./format/insights";
import {
  formatEnvironmentConcurrency,
  formatLimits,
  formatQueueDetails,
  formatQueueList,
  queueNotFound,
} from "./format/queues";
import { READ_BUDGET_MS, startReadBudget, stoppedText } from "./readBudget.server";
import { ListQueuesInput, QueueDetailsInput } from "./schemas/queues";
import { CommonProjectsInput } from "./schemas/common";
import { webhooksAvailable } from "./webhooksRead.server";

const ENVIRONMENT_NOT_FOUND = "Environment not found";
const CK_LIVE_LIMIT = 50;

const stopped = (read: { ok: false; reason: "timeout" | "aborted" }) =>
  plainError(stoppedText(read));

export const namedLimitNoDetails = (queueId: string) =>
  `${queueId} is a named concurrency limit, not a queue. Details exist only for queues.`;

async function isNamedLimit(environment: AuthenticatedEnvironment, queueId: string) {
  const row = await $replica.taskQueue.findFirst({
    where: { friendlyId: queueId, runtimeEnvironmentId: environment.id, role: "LIMIT" },
    select: { id: true },
  });
  return row !== null;
}

async function metricsAccess(ctx: McpToolContext, environment: AuthenticatedEnvironment) {
  return canAccessQueueMetricsUi({
    request: ctx.request,
    userId: ctx.identity.userId,
    organizationSlug: environment.organization.slug,
  });
}

function metricsWindow(
  period: string | undefined,
  maxPeriodDays: number,
  now: number
): { period: string; from: Date; to: Date } {
  const clamped = clampQueueMetricsPeriod(period ?? QUEUE_METRICS_DEFAULT_PERIOD, maxPeriodDays);
  const to = new Date(now);
  const range = clipQueueMetricsWindow(
    { from: new Date(now - (parse(clamped) ?? 0)), to },
    maxPeriodDays
  );
  return { period: clamped, ...range };
}

const invalidPeriod = (period: string | undefined) =>
  period !== undefined && !((parse(period) ?? 0) > 0);

type ReadOptions = { budgetMs: number; now: () => number };

const auth = { action: "read", subject: "queues" } as const;

export function createQueuesTools(
  options: ReadOptions = { budgetMs: READ_BUDGET_MS, now: () => Date.now() }
): McpToolDefinition[] {
  const startBudget = (ctx: McpToolContext) =>
    startReadBudget(options.budgetMs, ctx.signal, options.now);

  return [
    defineReadTool({
      name: "list_queues",
      title: "List Queues",
      description:
        "List the queues and named concurrency limits of an environment, like the Concurrency page in the dashboard: running and queued runs, paused and archived state, per-key and total limits with any override. With queue metrics, each queue also shows its scheduling delay p50/p95, peak backlog and throttling over a period (default 1h), and queues can be ordered by activity. 25 per page; archived queues that still have runs are listed too.",
      shape: ListQueuesInput.shape,
      auth,
      run: async (input, ctx) => {
        if (invalidPeriod(input.period)) {
          return plainError(`Invalid arguments: period=${input.period}`);
        }
        const budget = startBudget(ctx);
        const found = await budget.read(() => resolveToolEnvironment(ctx));
        if (!found.ok) return stopped(found);
        const environment = found.value;
        if (!environment) return plainError(ENVIRONMENT_NOT_FOUND);

        const access = await budget.read(() => metricsAccess(ctx, environment));
        if (!access.ok) return stopped(access);
        const metricsOn = access.value;
        const page = input.page ?? 1;
        const list = await budget.read(() =>
          new QueueListPresenter().call({
            environment,
            query: input.query,
            page,
            includeLimits: true,
            archived: input.includeArchived ? "include" : "exclude",
            detectArchivedActivity: true,
            sort: metricsOn ? (input.sort ?? "busiest") : "name",
            readLimit: budget.limit,
          })
        );
        if (!list.ok) return stopped(list);
        const { queues, pagination, activeArchivedQueues } = list.value;

        const metrics = await (async (): Promise<
          | Parameters<typeof formatQueueList>[0]["metrics"]
          | { ok: false; reason: "timeout" | "aborted" }
        > => {
          if (!metricsOn) return "unavailable";
          const maxPeriodDays = await budget.read(() =>
            queueMetricsMaxPeriodDays(environment.organizationId)
          );
          if (!maxPeriodDays.ok) return maxPeriodDays;
          if (queues.length === 0) return "not_read";
          const window = metricsWindow(input.period, maxPeriodDays.value, options.now());
          const result = await budget.read(() =>
            new QueueMetricsPresenter().getQueueListMetrics({
              environment,
              queueNames: queues.map(storedQueueName),
              from: window.from,
              to: window.to,
              readLimit: budget.limit(),
            })
          );
          if (!result.ok) return result;
          return {
            window: { ...window, bucketIntervalMs: result.value.bucketIntervalMs },
            byQueue: result.value.byQueue,
          };
        })();
        if (typeof metrics === "object" && "ok" in metrics) return stopped(metrics);

        return textResult(
          formatQueueList({
            queues,
            page,
            totalPages: pagination.mode === "unfiltered" ? pagination.totalPages : undefined,
            totalCount: pagination.mode === "unfiltered" ? pagination.count : undefined,
            hasMore: pagination.mode === "filtered" ? pagination.hasMore : undefined,
            activeArchived: activeArchivedQueues ?? [],
            metrics,
          })
        );
      },
    }),
    defineReadTool({
      name: "get_queue_details",
      title: "Get Queue Details",
      description:
        "Get one queue in full, like its page in the dashboard: running and queued runs, limits and overrides. With queue metrics, also the oldest queue position (priority counts as waiting time), the concurrency keys with queued runs now (most-starved first), also its scheduling delay p50/p95, peak backlog, throttling, and the backlog and throttling series over a period (default 1h, about 48 points).",
      shape: QueueDetailsInput.shape,
      auth,
      run: async (input, ctx) => {
        if (invalidPeriod(input.period)) {
          return plainError(`Invalid arguments: period=${input.period}`);
        }
        const budget = startBudget(ctx);
        const found = await budget.read(() => resolveToolEnvironment(ctx));
        if (!found.ok) return stopped(found);
        const environment = found.value;
        if (!environment) return plainError(ENVIRONMENT_NOT_FOUND);

        const retrieve = await budget.read(() =>
          new QueueRetrievePresenter().call({ environment, queueInput: input.queueId })
        );
        if (!retrieve.ok) return stopped(retrieve);
        if (!retrieve.value.success) {
          const limit = await budget.read(() => isNamedLimit(environment, input.queueId));
          if (!limit.ok) return stopped(limit);
          return plainError(
            limit.value ? namedLimitNoDetails(input.queueId) : queueNotFound(input.queueId)
          );
        }
        const queue = retrieve.value.queue;
        const fullName = storedQueueName(queue);

        const access = await budget.read(() => metricsAccess(ctx, environment));
        if (!access.ok) return stopped(access);
        if (!access.value) {
          return textResult(
            formatQueueDetails({
              queue,
              envLimit: environment.maximumConcurrencyLimit,
              now: options.now(),
              live: "unavailable",
            })
          );
        }

        const maxPeriodDays = await budget.read(() =>
          queueMetricsMaxPeriodDays(environment.organizationId)
        );
        if (!maxPeriodDays.ok) return stopped(maxPeriodDays);
        const window = metricsWindow(input.period, maxPeriodDays.value, options.now());
        const live = await budget.read(() =>
          Promise.all([
            engine.oldestMessageInQueue(environment, fullName),
            engine.concurrencyKeyBreakdown(environment, fullName, { limit: CK_LIVE_LIMIT }),
            new QueueMetricsPresenter().getQueueListMetrics({
              environment,
              queueNames: [fullName],
              from: window.from,
              to: window.to,
              readLimit: budget.limit(),
            }),
          ])
        );
        if (!live.ok) return stopped(live);
        const [oldestQueuedAt, keys, metrics] = live.value;
        return textResult(
          formatQueueDetails({
            queue,
            envLimit: environment.maximumConcurrencyLimit,
            now: options.now(),
            live: {
              oldestQueuedAt: oldestQueuedAt ?? null,
              keys,
              window: { ...window, bucketIntervalMs: metrics.bucketIntervalMs },
              metric: metrics.byQueue.get(fullName),
            },
          })
        );
      },
    }),
    defineReadTool({
      name: "get_environment_concurrency",
      title: "Get Environment Concurrency",
      description:
        "Get an environment's concurrency now, like the header of the Concurrency page in the dashboard: runs running and queued across all queues, the concurrency limit and burst factor, the queued-runs limit per queue, whether the environment is paused and why, and how much of the limit queues have reserved for themselves.",
      shape: CommonProjectsInput.shape,
      auth,
      run: async (_input, ctx) => {
        const budget = startBudget(ctx);
        const found = await budget.read(() => resolveToolEnvironment(ctx));
        if (!found.ok) return stopped(found);
        const environment = found.value;
        if (!environment) return plainError(ENVIRONMENT_NOT_FOUND);

        const state = await budget.read(() =>
          Promise.all([
            new EnvironmentQueuePresenter().call(environment),
            $replica.runtimeEnvironment.findFirst({
              where: { id: environment.id },
              select: { paused: true, pauseSource: true },
            }),
            metricsAccess(ctx, environment),
          ])
        );
        if (!state.ok) return stopped(state);
        const [current, pause, metricsOn] = state.value;

        const allocation = metricsOn
          ? await budget
              .read(() => new QueueAllocationPresenter().call({ environment }))
              .catch((error: unknown) => {
                logger.error("MCP queue tool failed", {
                  tool: "get_environment_concurrency",
                  error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
                });
                return { ok: true as const, value: "failed" as const };
              })
          : { ok: true as const, value: "unavailable" as const };
        if (!allocation.ok) return stopped(allocation);

        return textResult(
          formatEnvironmentConcurrency({
            environment: current,
            pause: pause ?? { paused: environment.paused, pauseSource: null },
            allocation: allocation.value,
          })
        );
      },
    }),
    defineReadTool({
      name: "get_limits",
      title: "Get Limits",
      description:
        "Get the limits that apply to an environment and its organization, like the Limits page in the dashboard: API and batch rate limits with the tokens available now; quotas with current usage, always projects, batch trigger concurrency and queued runs per queue, and schedules, team members, alert channels, preview branches, log retention, query period, dashboards and webhook limits when the plan sets them; and the plan's features.",
      shape: CommonProjectsInput.shape,
      auth: { action: "read", subject: "projects" },
      run: async (_input, ctx) => {
        const budget = startBudget(ctx);
        const found = await budget.read(() => resolveToolEnvironment(ctx));
        if (!found.ok) return stopped(found);
        const environment = found.value;
        if (!environment) return plainError(ENVIRONMENT_NOT_FOUND);

        const hasWebhooks = await budget.read(() => webhooksAvailable(ctx));
        if (!hasWebhooks.ok) return stopped(hasWebhooks);
        const result = await budget.read(() =>
          new LimitsPresenter().call({
            organizationId: environment.organizationId,
            projectId: environment.projectId,
            environmentId: environment.id,
            environmentType: environment.type,
            hasWebhooks: hasWebhooks.value,
          })
        );
        if (!result.ok) return stopped(result);
        return textResult(formatLimits(result.value));
      },
    }),
  ];
}

export const queuesTools = createQueuesTools();
