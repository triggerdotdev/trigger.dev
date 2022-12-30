import { prisma } from "~/db.server";
export type { ExternalSource } from ".prisma/client";

export type ExternalSourceWithConnection = Awaited<
  ReturnType<typeof findExternalSourceById>
>;

export async function findExternalSourceById(id: string) {
  return prisma.externalSource.findUnique({
    where: { id },
    include: {
      connection: true,
      organization: true,
    },
  });
}

export async function connectExternalSource({
  sourceId,
  connectionId,
}: {
  sourceId: string;
  connectionId: string;
}) {
  return await prisma.externalSource.update({
    where: {
      id: sourceId,
    },
    data: {
      connectionId: connectionId,
    },
  });
}
