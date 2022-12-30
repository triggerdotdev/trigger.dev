import { prisma } from "~/db.server";

export async function connectExternalService({
  serviceId,
  connectionId,
}: {
  serviceId: string;
  connectionId: string;
}) {
  return await prisma.externalService.update({
    where: {
      id: serviceId,
    },
    data: {
      connectionId: connectionId,
    },
  });
}
