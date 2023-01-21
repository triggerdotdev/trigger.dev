import { prisma } from "~/db.server";
import type { FetchRequest } from ".prisma/client";

export type { FetchRequest };

export async function findFetchRequestById(id: string) {
  return prisma.fetchRequest.findUnique({
    where: {
      id,
    },
    include: {
      step: true,
      run: true,
    },
  });
}
