import { logger, resumeTokens, task } from "@trigger.dev/sdk/v3";

export const resumeToken = task({
  id: "resume-token",
  run: async (payload: any, { ctx }) => {
    logger.log("Hello, world", { payload });

    const token = await resumeTokens.create();
    logger.log("Token", token);
  },
});
