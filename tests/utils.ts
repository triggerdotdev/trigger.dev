import { PrismaClient } from "@trigger.dev/database";

type SetDBCallback = (prisma: PrismaClient) => Promise<void>;

export const setDB = async (cb: SetDBCallback) => {
  const { DATABASE_URL } = process.env;

  const prisma = new PrismaClient({
    datasources: {
      db: {
        url: DATABASE_URL,
      },
    },
  });

  await prisma.$connect();
  await cb(prisma);
  await prisma.$disconnect();
};
