import { TaskTriggerSource } from "@trigger.dev/database";
import { $replica, prisma } from "~/db.server";
import { getAllTaskIdentifiers } from "~/models/task.server";
import { logger } from "./logger.server";
import {
  getTaskIdentifiersFromCache,
  populateTaskIdentifierCache,
  type TaskIdentifierEntry,
} from "./taskIdentifierCache.server";

function toTriggerSource(source: string | undefined): TaskTriggerSource {
  if (source === "SCHEDULED" || source === "schedule") return "SCHEDULED";
  if (source === "AGENT" || source === "agent") return "AGENT";
  return "STANDARD";
}

export async function syncTaskIdentifiers(
  environmentId: string,
  projectId: string,
  workerId: string,
  tasks: { id: string; triggerSource?: string }[]
): Promise<void> {
  const slugs = tasks.map((t) => t.id);

  for (const task of tasks) {
    await prisma.taskIdentifier.upsert({
      where: {
        runtimeEnvironmentId_slug: {
          runtimeEnvironmentId: environmentId,
          slug: task.id,
        },
      },
      create: {
        runtimeEnvironmentId: environmentId,
        projectId,
        slug: task.id,
        currentTriggerSource: toTriggerSource(task.triggerSource),
        currentWorkerId: workerId,
        isInLatestDeployment: true,
      },
      update: {
        currentTriggerSource: toTriggerSource(task.triggerSource),
        currentWorkerId: workerId,
        lastSeenAt: new Date(),
        isInLatestDeployment: true,
      },
    });
  }

  if (slugs.length > 0) {
    await prisma.taskIdentifier.updateMany({
      where: {
        runtimeEnvironmentId: environmentId,
        slug: { notIn: slugs },
        isInLatestDeployment: true,
      },
      data: { isInLatestDeployment: false },
    });
  }

  const allIdentifiers = await prisma.taskIdentifier.findMany({
    where: { runtimeEnvironmentId: environmentId },
    select: {
      slug: true,
      currentTriggerSource: true,
      isInLatestDeployment: true,
    },
  });

  populateTaskIdentifierCache(
    environmentId,
    allIdentifiers.map((t) => ({
      slug: t.slug,
      triggerSource: t.currentTriggerSource,
      isInLatestDeployment: t.isInLatestDeployment,
    }))
  ).catch((error) => {
    logger.error("Failed to populate task identifier cache after sync", { environmentId, error });
  });
}

function sortEntries(entries: TaskIdentifierEntry[]): TaskIdentifierEntry[] {
  return entries.sort((a, b) => {
    if (a.isInLatestDeployment !== b.isInLatestDeployment)
      return a.isInLatestDeployment ? -1 : 1;
    return a.slug.localeCompare(b.slug);
  });
}

export async function getTaskIdentifiers(
  environmentId: string
): Promise<TaskIdentifierEntry[]> {
  const cached = await getTaskIdentifiersFromCache(environmentId);
  if (cached) return sortEntries(cached);

  const dbRows = await $replica.taskIdentifier.findMany({
    where: { runtimeEnvironmentId: environmentId },
    select: {
      slug: true,
      currentTriggerSource: true,
      isInLatestDeployment: true,
    },
  });

  if (dbRows.length > 0) {
    const entries: TaskIdentifierEntry[] = dbRows.map((t) => ({
      slug: t.slug,
      triggerSource: t.currentTriggerSource,
      isInLatestDeployment: t.isInLatestDeployment,
    }));

    populateTaskIdentifierCache(environmentId, entries).catch((error) => {
      logger.error("Failed to populate task identifier cache after DB read", {
        environmentId,
        error,
      });
    });

    return sortEntries(entries);
  }

  const legacyRows = await getAllTaskIdentifiers($replica, environmentId);
  const entries: TaskIdentifierEntry[] = legacyRows.map((t) => ({
    slug: t.slug,
    triggerSource: t.triggerSource,
    isInLatestDeployment: true,
  }));

  if (entries.length > 0) {
    populateTaskIdentifierCache(environmentId, entries).catch((error) => {
      logger.error("Failed to populate task identifier cache after legacy fallback", {
        environmentId,
        error,
      });
    });
  }

  return sortEntries(entries);
}
