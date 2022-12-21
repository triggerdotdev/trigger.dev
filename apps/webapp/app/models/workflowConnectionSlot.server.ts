import { prisma } from "~/db.server";

export async function findWorkflowConnectionSlotById(id: string) {
  return prisma.workflowConnectionSlot.findFirst({
    where: {
      id,
    },
    include: {
      connection: true,
      workflow: true,
      trigger: true,
      registeredWebhook: true,
    },
  });
}
