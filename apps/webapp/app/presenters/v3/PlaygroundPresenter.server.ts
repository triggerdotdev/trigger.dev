import type {
  RuntimeEnvironmentType,
  TaskRunStatus,
  TaskTriggerSource,
} from "@trigger.dev/database";
import { $replica } from "~/db.server";
import { findCurrentWorkerFromEnvironment } from "~/v3/models/workerDeployment.server";
import { runStore } from "~/v3/runStore.server";
import { isFinalRunStatus } from "~/v3/taskStatus";

export type PlaygroundAgent = {
  slug: string;
  filePath: string;
  triggerSource: TaskTriggerSource;
  config: unknown;
  payloadSchema: unknown;
};

export type PlaygroundConversation = {
  id: string;
  chatId: string;
  title: string;
  agentSlug: string;
  runFriendlyId: string | null;
  runStatus: TaskRunStatus | null;
  clientData: unknown;
  messages: unknown;
  lastEventId: string | null;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
};

export class PlaygroundPresenter {
  async listAgents({
    environmentId,
    environmentType,
  }: {
    environmentId: string;
    environmentType: RuntimeEnvironmentType;
  }): Promise<PlaygroundAgent[]> {
    const currentWorker = await findCurrentWorkerFromEnvironment(
      { id: environmentId, type: environmentType },
      $replica
    );

    if (!currentWorker) return [];

    return $replica.backgroundWorkerTask.findMany({
      where: {
        workerId: currentWorker.id,
        triggerSource: "AGENT",
      },
      select: {
        slug: true,
        filePath: true,
        triggerSource: true,
        config: true,
        payloadSchema: true,
      },
      orderBy: { slug: "asc" },
    });
  }

  async getAgent({
    environmentId,
    environmentType,
    agentSlug,
  }: {
    environmentId: string;
    environmentType: RuntimeEnvironmentType;
    agentSlug: string;
  }): Promise<PlaygroundAgent | null> {
    const currentWorker = await findCurrentWorkerFromEnvironment(
      { id: environmentId, type: environmentType },
      $replica
    );

    if (!currentWorker) return null;

    return $replica.backgroundWorkerTask.findFirst({
      where: {
        workerId: currentWorker.id,
        triggerSource: "AGENT",
        slug: agentSlug,
      },
      select: {
        slug: true,
        filePath: true,
        triggerSource: true,
        config: true,
        payloadSchema: true,
      },
    });
  }

  async getRecentConversations({
    environmentId,
    agentSlug,
    userId,
    limit = 10,
  }: {
    environmentId: string;
    agentSlug: string;
    userId: string;
    limit?: number;
  }): Promise<PlaygroundConversation[]> {
    const conversations = await $replica.playgroundConversation.findMany({
      where: {
        runtimeEnvironmentId: environmentId,
        agentSlug,
        userId,
      },
      select: {
        id: true,
        chatId: true,
        title: true,
        agentSlug: true,
        clientData: true,
        messages: true,
        lastEventId: true,
        createdAt: true,
        updatedAt: true,
        runId: true,
      },
      orderBy: { updatedAt: "desc" },
      take: limit,
    });

    // The conversation->run relation crosses the run-graph seam, so we resolve the backing
    // run's scalars via the run-store instead of relation-joining. `findRuns` routes the
    // (possibly mixed-residency) id set to the correct store(s) by id shape.
    const runIds = conversations.map((c) => c.runId).filter((id): id is string => id !== null);

    const runsById = new Map<string, { friendlyId: string; status: TaskRunStatus }>();
    if (runIds.length > 0) {
      const runs = await runStore.findRuns({
        where: { id: { in: runIds } },
        select: { id: true, friendlyId: true, status: true },
      });
      for (const run of runs) {
        runsById.set(run.id, { friendlyId: run.friendlyId, status: run.status });
      }
    }

    return conversations.map((c) => {
      const run = c.runId ? (runsById.get(c.runId) ?? null) : null;
      return {
        id: c.id,
        chatId: c.chatId,
        title: c.title,
        agentSlug: c.agentSlug,
        runFriendlyId: run?.friendlyId ?? null,
        runStatus: run?.status ?? null,
        clientData: c.clientData,
        messages: c.messages,
        lastEventId: c.lastEventId,
        isActive: run?.status ? !isFinalRunStatus(run.status) : false,
        createdAt: c.createdAt,
        updatedAt: c.updatedAt,
      };
    });
  }
}

export const playgroundPresenter = new PlaygroundPresenter();
