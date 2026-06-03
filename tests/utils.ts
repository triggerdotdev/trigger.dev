import { PrismaClient } from "@trigger.dev/database";
import { PrismaPg } from "@prisma/adapter-pg";

type SetDBCallback = (prisma: PrismaClient) => Promise<void>;

export const setDB = async (cb: SetDBCallback) => {
  const { DATABASE_URL } = process.env;

  const adapter = new PrismaPg(DATABASE_URL ?? "postgresql://localhost:5432/trigger");
  const prisma = new PrismaClient({ adapter });

  await prisma.$connect();
  await cb(prisma);
  await prisma.$disconnect();
};
