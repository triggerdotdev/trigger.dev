import { Prisma } from "@trigger.dev/database";
import { runStore } from "~/v3/runStore.server";

export const MAX_TAGS_PER_WAITPOINT = 10;
const MAX_RETRIES = 3;

export async function createWaitpointTag({
  tag,
  environmentId,
  projectId,
  residency,
}: {
  tag: string;
  environmentId: string;
  projectId: string;
  // Residency from the env mint kind: a tag has no owning run, so a minted-new env pins it to NEW
  // instead of defaulting to the draining legacy DB.
  residency?: "NEW" | "LEGACY";
}) {
  if (tag.trim().length === 0) return;

  let attempts = 0;

  while (attempts < MAX_RETRIES) {
    try {
      return await runStore.upsertWaitpointTag(
        {
          environmentId,
          name: tag,
          projectId,
        },
        undefined,
        residency
      );
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
