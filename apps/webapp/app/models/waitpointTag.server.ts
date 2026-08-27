import { Prisma } from "@trigger.dev/database";
import { runStore } from "~/v3/runStore.server";

export const MAX_TAGS_PER_WAITPOINT = 10;
const MAX_RETRIES = 3;

export async function createWaitpointTag({
  tag,
  environmentId,
  projectId,
  residency,
  shardKey,
}: {
  tag: string;
  environmentId: string;
  projectId: string;
  // Residency from the env mint kind: a tag has no owning run, so a minted-new env pins it to NEW
  // instead of defaulting to the draining legacy DB.
  residency?: "NEW" | "LEGACY";
  // The environment's gen-2 mint shard, when it has one. A tag has no id the router can read, so
  // without this the row lands on a gen-1 store while the token it describes lands on the shard.
  shardKey?: string;
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
        residency,
        shardKey
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
