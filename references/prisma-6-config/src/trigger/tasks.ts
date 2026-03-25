import { AbortTaskRunError, task } from "@trigger.dev/sdk";
import { db } from "../db.js";

export const createUserTask = task({
  id: "create-user",
  run: async (payload: { email: string; name: string; avatarUrl: string }) => {
    const existingUser = await db.user.findUnique({
      where: {
        email: payload.email,
      },
    });

    if (existingUser) {
      throw new AbortTaskRunError("User already exists");
    }

    const user = await db.user.create({
      data: payload,
    });
    return user;
  },
});
