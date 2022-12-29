import { prisma } from "~/db.server";
import type { IntegrationRequest } from ".prisma/client";

export type { IntegrationRequest };

export async function findIntegrationRequestById(id: string) {
  return prisma.integrationRequest.findUnique({
    where: {
      id,
    },
    include: {
      externalService: true,
      step: true,
      run: true,
    },
  });
}
