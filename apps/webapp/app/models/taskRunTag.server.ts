import { prisma } from "~/db.server";
import { generateFriendlyId } from "~/v3/friendlyIdentifiers";

export async function createTag({ tag, projectId }: { tag: string; projectId: string }) {
  if (tag.trim().length === 0) return;
  return prisma.taskRunTag.upsert({
    where: {
      projectId_name: {
        projectId: projectId,
        name: tag,
      },
    },
    create: {
      name: tag,
      friendlyId: generateFriendlyId("runtag"),
      projectId: projectId,
    },
    update: {},
  });
}

export async function getTagsForRunId({
  friendlyId,
  environmentId,
}: {
  friendlyId: string;
  environmentId: string;
}) {
  const run = await prisma.taskRun.findFirst({
    where: {
      friendlyId,
      runtimeEnvironmentId: environmentId,
    },
    select: {
      tags: true,
    },
  });

  return run?.tags ?? undefined;
}
