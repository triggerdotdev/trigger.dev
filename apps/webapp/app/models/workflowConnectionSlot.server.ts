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

export async function getWorkflowConnectionSlotsForWorkspace(id: string) {
  return prisma.workflowConnectionSlot.findMany({
    where: {
      workflowId: id,
    },
    select: {
      id: true,
      serviceIdentifier: true,
      slotName: true,
      auth: true,
      connection: true,
      trigger: {
        select: {
          id: true,
          status: true,
        },
      },
    },
  });
}
