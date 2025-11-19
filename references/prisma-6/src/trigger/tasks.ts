import { AbortTaskRunError, task } from "@trigger.dev/sdk";
import { db, sql } from "../db.js";

export const createUserTask = task({
  id: "create-user",
  run: async (payload: { email: string; name: string; avatarUrl: string }) => {
    const existingUser = await db.$queryRawTyped(sql.getUserByEmail(payload.email));

    if (existingUser.length > 0) {
      throw new AbortTaskRunError("User already exists");
    }

    const user = await db.user.create({
      data: payload,
    });
    return user;
  },
});
