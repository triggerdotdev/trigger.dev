import { type PrismaClient, TaskTriggerSource } from "@trigger.dev/database";
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
  return "STANDARD";
}

export async function syncTaskIdentifiers(
  environmentId: string,
  projectId: string,
  workerId: string,
  tasks: { id: string; triggerSource?: string }[],
  db: PrismaClient = prisma
): Promise<void> {
  const slugs = tasks.map((t) => t.id);
  const now = new Date();

  // Group slugs by resolved triggerSource for bulk updates
  const slugsBySource = new Map<TaskTriggerSource, string[]>();
  for (const task of tasks) {
    const source = toTriggerSource(task.triggerSource);
    const existing = slugsBySource.get(source);
    if (existing) {
      existing.push(task.id);
    } else {
      slugsBySource.set(source, [task.id]);
    }
  }

  // Batch: insert new rows, update existing rows per source group, archive removed tasks
  await db.$transaction([
    // Insert any new task identifiers (skips rows that already exist)
    db.taskIdentifier.createMany({
      data: tasks.map((task) => ({
        runtimeEnvironmentId: environmentId,
        projectId,
        slug: task.id,
        currentTriggerSource: toTriggerSource(task.triggerSource),
        currentWorkerId: workerId,
      })),
      skipDuplicates: true,
    }),
    // Update existing rows — one updateMany per distinct triggerSource value
    ...Array.from(slugsBySource.entries()).map(([source, taskSlugs]) =>
      db.taskIdentifier.updateMany({
        where: {
          runtimeEnvironmentId: environmentId,
          slug: { in: taskSlugs },
        },
        data: {
          currentTriggerSource: source,
          currentWorkerId: workerId,
          lastSeenAt: now,
          isInLatestDeployment: true,
        },
      })
    ),
    // Archive tasks no longer in this deploy
    db.taskIdentifier.updateMany({
      where: {
        runtimeEnvironmentId: environmentId,
        slug: { notIn: slugs },
        isInLatestDeployment: true,
      },
      data: { isInLatestDeployment: false },
    }),
  ]);

  const allIdentifiers = await db.taskIdentifier.findMany({
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
  environmentId: string,
  db: PrismaClient = $replica
): Promise<TaskIdentifierEntry[]> {
  const cached = await getTaskIdentifiersFromCache(environmentId);
  if (cached) return sortEntries(cached);

  const dbRows = await db.taskIdentifier.findMany({
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

  const legacyRows = await getAllTaskIdentifiers(db, environmentId);
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
