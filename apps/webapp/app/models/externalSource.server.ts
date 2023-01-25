import { prisma } from "~/db.server";
import type { ExternalSource } from ".prisma/client";
import { env } from "process";

export type { ExternalSource };

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

export function buildExternalSourceUrl(id: string, serviceIdentifier: string) {
  return `${env.APP_ORIGIN}/api/v1/internal/webhooks/${serviceIdentifier}/${id}`;
}
