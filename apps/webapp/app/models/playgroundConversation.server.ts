import { prisma } from "~/db.server";

/**
 * Deletes the user's own playground conversation row in the environment. Only the row goes:
 * its session and runs stay. With `revision`, only while it is still at that revision.
 */
export function deletePlaygroundConversation(
  conversation: { id: string; runtimeEnvironmentId: string; userId: string },
  revision?: Date
) {
  return prisma.playgroundConversation.deleteMany({
    where: { ...conversation, ...(revision ? { updatedAt: revision } : {}) },
  });
}
