import type { RuntimeEnvironmentType, TaskRunStatus, TaskTriggerSource } from "@trigger.dev/database";
import { $replica } from "~/db.server";
import { findCurrentWorkerFromEnvironment } from "~/v3/models/workerDeployment.server";
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
        run: {
          select: {
            friendlyId: true,
            status: true,
          },
        },
      },
      orderBy: { updatedAt: "desc" },
      take: limit,
    });

    return conversations.map((c) => ({
      id: c.id,
      chatId: c.chatId,
      title: c.title,
      agentSlug: c.agentSlug,
      runFriendlyId: c.run?.friendlyId ?? null,
      runStatus: c.run?.status ?? null,
      clientData: c.clientData,
      messages: c.messages,
      lastEventId: c.lastEventId,
      isActive: c.run?.status ? !isFinalRunStatus(c.run.status) : false,
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
    }));
  }
}

export const playgroundPresenter = new PlaygroundPresenter();
