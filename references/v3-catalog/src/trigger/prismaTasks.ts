import { prisma } from "@/db.js";
import { task } from "@trigger.dev/sdk/v3";

export const prismaTask = task({
  id: "prisma-task",
  run: async () => {
    const users = await prisma.user.findMany();

    await prisma.user.create({
      data: {
        name: "Alice",
      },
    });

    return users;
  },
});
