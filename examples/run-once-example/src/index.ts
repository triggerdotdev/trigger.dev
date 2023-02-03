import { customEvent, Trigger } from "@trigger.dev/sdk";
import { z } from "zod";

class ExampleIdempotentService {
  private keyCounts = new Map<string, number>();
  private users = new Map<string, any>();

  async updateUser(
    idempotencyKey: string,
    id: string,
    updates: Record<string, string>
  ) {
    console.log("runOnce callback called", { idempotencyKey });

    const count = this.keyCounts.get(idempotencyKey) || 0;

    if (count > 0) {
      return this.users.get(id);
    }

    this.keyCounts.set(idempotencyKey, count + 1);

    console.log("Updating user", { id, updates, idempotencyKey });

    const user = {
      id,
      ...updates,
      updateCount: count + 1, // updateCount should never be > 1 (or else idempotency failed)
    };

    this.users.set(id, user);

    return user;
  }

  async updateUserWithErrors(
    idempotencyKey: string,
    id: string,
    updates: Record<string, string>
  ) {
    throw new Error("This is an error");
  }
}

const service = new ExampleIdempotentService();

new Trigger({
  id: "run-once",
  name: "Run once examples",
  apiKey: "trigger_dev_zC25mKNn6c0q",
  endpoint: "ws://localhost:8889/ws",
  on: customEvent({
    name: "update.user",
    schema: z.object({
      id: z.string(),
      updates: z.record(z.string()),
      throwError: z.boolean().default(false),
    }),
  }),
  run: async (event, ctx) => {
    const output1 = await ctx.runOnce("update-user-once", async (key) => {
      return service.updateUser(key, event.id, event.updates);
    });

    await ctx.logger.info("Updated the user once", {
      output1,
    });

    const output2 = await ctx.runOnce("update-user-once", async (key) => {
      return service.updateUser(key, event.id, event.updates);
    });

    await ctx.logger.info("Updated the user twice", {
      output2,
    });

    const output3 = await ctx.runOnce("update-user-twice", async (key) => {
      return service.updateUser(key, event.id, event.updates);
    });

    await ctx.logger.info("Updated the user thrice", {
      output3,
    });

    const output4 = await ctx.runOnceLocalOnly(
      "update-user-local-only",
      async (key) => {
        return service.updateUser(key, event.id, event.updates);
      }
    );

    await ctx.logger.info("Updated the user local only", {
      output4,
    });

    const output5 = await ctx.runOnceLocalOnly(
      "update-user-local-only",
      async (key) => {
        return service.updateUser(key, event.id, event.updates);
      }
    );

    await ctx.logger.info("Updated the user local only again", {
      output5,
    });

    if (event.throwError) {
      await ctx.runOnce("update-user-error", async (key) => {
        return service.updateUserWithErrors(key, event.id, event.updates);
      });
    }

    return { output1, output2, output3, output4, output5 };
  },
}).listen();
