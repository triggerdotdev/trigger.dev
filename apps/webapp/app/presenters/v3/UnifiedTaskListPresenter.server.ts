import {
  type PrismaClientOrTransaction,
  type RuntimeEnvironmentType,
  type TaskTriggerSource,
} from "@trigger.dev/database";
import { $replica } from "~/db.server";
import { clickhouseFactory } from "~/services/clickhouse/clickhouseFactoryInstance.server";
import {
  ClickHouseEnvironmentMetricsRepository,
  type DailyTaskActivity,
} from "~/services/environmentMetricsRepository.server";
import { singleton } from "~/utils/singleton";
import { agentListPresenter, type AgentActiveState } from "./AgentListPresenter.server";
import { taskListPresenter, type TaskListItem } from "./TaskListPresenter.server";

export type UnifiedTaskKind = "STANDARD" | "SCHEDULED" | "AGENT";

export type UnifiedTaskListItem = {
  kind: UnifiedTaskKind;
  slug: string;
  filePath: string;
  triggerSource: TaskTriggerSource;
  createdAt: Date;
  /** Agent-only: parsed `config.type` used for the Type badge. */
  agentType?: string;
};

export type UnifiedRunningState =
  | { kind: "task"; running: number }
  | { kind: "agent"; running: number; suspended: number };

export type UnifiedRunningStates = Record<string, UnifiedRunningState>;

export class UnifiedTaskListPresenter {
  constructor(private readonly _replica: PrismaClientOrTransaction) {}

  public async call(args: {
    organizationId: string;
    projectId: string;
    environmentId: string;
    environmentType: RuntimeEnvironmentType;
  }): Promise<{
    items: UnifiedTaskListItem[];
    activity: Promise<DailyTaskActivity>;
    runningStates: Promise<UnifiedRunningStates>;
  }> {
    const [taskResult, agentResult] = await Promise.all([
      taskListPresenter.call(args),
      agentListPresenter.call(args),
    ]);

    const items = toUnifiedItems(taskResult.tasks, agentResult.agents);

    // Unified activity fetch: one call across both task and agent slugs so
    // the chart cell can look up `data[slug]` for every row regardless of
    // kind. Discards the activity promise already returned by
    // `taskListPresenter` (it would have been awaited once anyway).
    const allSlugs = items.map((item) => item.slug);
    const activity =
      allSlugs.length === 0
        ? Promise.resolve({} as DailyTaskActivity)
        : (async () => {
            const clickhouse = await clickhouseFactory.getClickhouseForOrganization(
              args.organizationId,
              "standard"
            );
            const repo = new ClickHouseEnvironmentMetricsRepository({ clickhouse });
            return repo.getDailyTaskActivity({
              organizationId: args.organizationId,
              projectId: args.projectId,
              environmentId: args.environmentId,
              days: 6, // 7 days inclusive of today, matching the Standard Tasks page
              tasks: allSlugs,
            });
          })();

    const runningStates: Promise<UnifiedRunningStates> = Promise.all([
      taskResult.runningStats,
      agentResult.activeStates,
    ]).then(([runningStats, activeStates]) => mergeRunningStates(runningStats, activeStates));

    return { items, activity, runningStates };
  }
}

function toUnifiedItems(
  tasks: TaskListItem[],
  agents: Array<{
    slug: string;
    filePath: string;
    createdAt: Date;
    triggerSource: TaskTriggerSource;
    config: unknown;
  }>
): UnifiedTaskListItem[] {
  const items: UnifiedTaskListItem[] = [];

  for (const task of tasks) {
    items.push({
      kind: task.triggerSource === "SCHEDULED" ? "SCHEDULED" : "STANDARD",
      slug: task.slug,
      filePath: task.filePath,
      triggerSource: task.triggerSource,
      createdAt: task.createdAt,
    });
  }

  for (const agent of agents) {
    items.push({
      kind: "AGENT",
      slug: agent.slug,
      filePath: agent.filePath,
      triggerSource: agent.triggerSource,
      createdAt: agent.createdAt,
      agentType: (agent.config as { type?: string } | null)?.type,
    });
  }

  items.sort((a, b) => a.slug.localeCompare(b.slug));
  return items;
}

function mergeRunningStates(
  runningStats: Record<string, { running: number; queued: number }>,
  activeStates: Record<string, AgentActiveState>
): UnifiedRunningStates {
  const out: UnifiedRunningStates = {};

  for (const [slug, stats] of Object.entries(runningStats)) {
    out[slug] = { kind: "task", running: stats?.running ?? 0 };
  }

  for (const [slug, state] of Object.entries(activeStates)) {
    out[slug] = {
      kind: "agent",
      running: state?.running ?? 0,
      suspended: state?.suspended ?? 0,
    };
  }

  return out;
}

function setupUnifiedTaskListPresenter() {
  return new UnifiedTaskListPresenter($replica);
}

export const unifiedTaskListPresenter = singleton(
  "unifiedTaskListPresenter",
  setupUnifiedTaskListPresenter
);
