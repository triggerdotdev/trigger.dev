import { prisma } from "~/db.server";
import { Prettify } from "~/lib.es5";

export type ExtendedEndpoint = Prettify<
  Awaited<ReturnType<typeof findEndpoint>>
>;

export async function findEndpoint(id: string) {
  return await prisma.endpoint.findUniqueOrThrow({
    where: {
      id,
    },
    include: {
      environment: {
        include: {
          project: true,
          organization: true,
        },
      },
    },
  });
}
