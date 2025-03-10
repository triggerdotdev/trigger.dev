import { Prisma, type PrismaClientOrTransaction } from "@trigger.dev/database";
import { generateFriendlyId } from "~/v3/friendlyIdentifiers";
import cuid from "cuid";
import { prisma } from "~/db.server";

export const MAX_TAGS_PER_RUN = 10;

export async function createTag({ tag, projectId }: { tag: string; projectId: string }) {
  if (tag.trim().length === 0) return;

  const friendlyId = generateFriendlyId("runtag");
  const now = new Date();
  const id = cuid();

  return await prisma
    .$queryRaw<Array<{ id: string; friendlyId: string; name: string; projectId: string }>>(
      Prisma.sql`
      INSERT INTO "TaskRunTag" ("id", "friendlyId", "name", "projectId", "createdAt")
      VALUES (${id}, ${friendlyId}, ${tag}, ${projectId}, ${now})
      ON CONFLICT ("projectId", "name") 
      DO UPDATE SET "friendlyId" = "TaskRunTag"."friendlyId"
      RETURNING "id", "friendlyId", "name", "projectId"
    `
    )
    .then((rows) => rows[0]);
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
