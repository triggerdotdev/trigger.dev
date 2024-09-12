import { getUsersWithPosts, prisma } from "@/db.js";
import { logger, task } from "@trigger.dev/sdk/v3";

export const prismaTask = task({
  id: "prisma-task",
  run: async () => {
    const users = await prisma.user.findMany();

    await prisma.user.create({
      data: {
        name: "Alice",
      },
    });

    const usersWithPosts = await prisma.$queryRawTyped(getUsersWithPosts());

    logger.info("Users with posts", { usersWithPosts });

    return users;
  },
});
