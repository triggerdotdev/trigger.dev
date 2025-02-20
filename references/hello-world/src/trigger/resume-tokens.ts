import { logger, resumeTokens, task } from "@trigger.dev/sdk/v3";

export const resumeToken = task({
  id: "resume-token",
  run: async (payload: any, { ctx }) => {
    logger.log("Hello, world", { payload });

    const idempotencyKey = "a";

    const token = await resumeTokens.create({
      idempotencyKey,
      timeout: new Date(Date.now() + 5_000),
    });
    logger.log("Token", token);

    const token2 = await resumeTokens.create({ idempotencyKey, timeout: "10s" });
    logger.log("Token2", token2);
  },
});
