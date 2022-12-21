import { prisma } from "~/db.server";

export type RegisteredWebhookWithRelationships = NonNullable<
  Awaited<ReturnType<typeof findRegisteredWebhookById>>
>;

export async function findRegisteredWebhookById(id: string) {
  return prisma.registeredWebhook.findFirst({
    where: {
      id,
    },
    include: {
      connectionSlot: {
        include: {
          connection: true,
        },
      },
      trigger: true,
      workflow: true,
    },
  });
}
