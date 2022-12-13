import type { RuntimeEnvironment } from ".prisma/client";
import { prisma } from "~/db.server";

export type { RuntimeEnvironment };

export async function findEnvironmentByApiKey(apiKey: string) {
  const environment = await prisma.runtimeEnvironment.findUnique({
    where: {
      apiKey,
    },
    include: {
      organization: true,
    },
  });

  return environment;
}
