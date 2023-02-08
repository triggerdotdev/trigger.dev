import { prisma } from "~/db.server";

export async function adminGetUsers() {
  return await prisma.user.findMany({
    orderBy: {
      createdAt: "desc",
    },
  });
}
