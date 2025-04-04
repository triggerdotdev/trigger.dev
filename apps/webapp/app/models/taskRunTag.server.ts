import { Prisma } from "@trigger.dev/database";
import { prisma } from "~/db.server";
import { generateFriendlyId } from "~/v3/friendlyIdentifiers";
import { PrismaClientOrTransaction } from "@trigger.dev/database";

export const MAX_TAGS_PER_RUN = 10;
const MAX_RETRIES = 3;

export async function createTag(
  { tag, projectId }: { tag: string; projectId: string },
  prismaClient: PrismaClientOrTransaction = prisma
) {
  if (tag.trim().length === 0) return;

  let attempts = 0;
  const friendlyId = generateFriendlyId("runtag");

  while (attempts < MAX_RETRIES) {
    try {
      return await prisma.taskRunTag.upsert({
        where: {
          projectId_name: {
            projectId,
            name: tag,
          },
        },
        create: {
          friendlyId,
          name: tag,
          projectId,
        },
        update: {},
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        // Handle unique constraint violation (conflict)
        attempts++;
        if (attempts >= MAX_RETRIES) {
          throw new Error(`Failed to create tag after ${MAX_RETRIES} attempts due to conflicts.`);
        }
      } else {
        throw error; // Re-throw other errors
      }
    }
  }
}

export type TagRecord = {
  id: string;
  name: string;
};

export async function createTags(
  {
    tags,
    projectId,
  }: {
    tags: string | string[] | undefined;
    projectId: string;
  },
  prismaClient: PrismaClientOrTransaction = prisma
): Promise<TagRecord[]> {
  if (!tags) {
    return [];
  }

  const tagsArray = typeof tags === "string" ? [tags] : tags;

  if (tagsArray.length === 0) {
    return [];
  }

  const tagRecords: TagRecord[] = [];
  for (const tag of tagsArray) {
    const tagRecord = await createTag(
      {
        tag,
        projectId,
      },
      prismaClient
    );
    if (tagRecord) {
      tagRecords.push({ id: tagRecord.id, name: tagRecord.name });
    }
  }

  return tagRecords;
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
