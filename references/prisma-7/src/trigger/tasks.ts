import { task } from "@trigger.dev/sdk";
import { db } from "../db.js";

export const createUserTask = task({
  id: "create-user",
  run: async (payload: { email: string; name: string; avatarUrl: string }) => {
    const user = await db.user.create({
      data: payload,
    });
    return user;
  },
});
