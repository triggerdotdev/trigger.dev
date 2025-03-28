import { Prisma } from "@trigger.dev/database";
import { prisma } from "~/db.server";

export const MAX_TAGS_PER_WAITPOINT = 10;
const MAX_RETRIES = 3;

export async function createWaitpointTag({
  tag,
  environmentId,
  projectId,
}: {
  tag: string;
  environmentId: string;
  projectId: string;
}) {
  if (tag.trim().length === 0) return;

  let attempts = 0;

  while (attempts < MAX_RETRIES) {
    try {
      return await prisma.waitpointTag.upsert({
        where: {
          environmentId_name: {
            environmentId,
            name: tag,
          },
        },
        create: {
          name: tag,
          environmentId,
          projectId,
        },
        update: {},
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        // Handle unique constraint violation (conflict)
        attempts++;
        if (attempts >= MAX_RETRIES) {
          throw new Error(
            `Failed to create waitpoint tag after ${MAX_RETRIES} attempts due to conflicts.`
          );
        }
      } else {
        throw error; // Re-throw other errors
      }
    }
  }
}
