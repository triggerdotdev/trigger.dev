import { auth, batch, logger, runs, task, tasks, timeout, wait } from "@trigger.dev/sdk";

export const publicAccessTokensTask = task({
  id: "public-access-tokens",
  run: async (payload: any, { ctx }) => {
    const token = await auth.createPublicToken({
      scopes: {
        read: {
          runs: [ctx.run.id],
        },
      },
    });

    logger.info("Token", { token });

    await auth.withAuth({ accessToken: token }, async () => {
      const run = await runs.retrieve(ctx.run.id);
      logger.info("Run", { run });
    });
  },
});
