import { prisma } from "~/db.server";

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
