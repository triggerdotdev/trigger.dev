import type { PrismaClient } from "@trigger.dev/database";
import { customAlphabet } from "nanoid";

// Must match friendlyId.ts IdUtil alphabet so generated IDs are valid.
const idGenerator = customAlphabet("123456789abcdefghijkmnopqrstuvwxyz", 21);

// Seeds a Waitpoint already in COMPLETED status so the waitpoints/:id/complete
// handler short-circuits with { success: true }. That keeps the "auth passes"
// assertion independent of run-engine workers (which are disabled in e2e).
export async function seedTestWaitpoint(
  prisma: PrismaClient,
  opts: { environmentId: string; projectId: string }
): Promise<{ id: string; friendlyId: string }> {
  const internalId = idGenerator();
  const friendlyId = `waitpoint_${internalId}`;
  await prisma.waitpoint.create({
    data: {
      id: internalId,
      friendlyId,
      type: "MANUAL",
      status: "COMPLETED",
      idempotencyKey: internalId,
      userProvidedIdempotencyKey: false,
      environmentId: opts.environmentId,
      projectId: opts.projectId,
    },
  });
  return { id: internalId, friendlyId };
}
