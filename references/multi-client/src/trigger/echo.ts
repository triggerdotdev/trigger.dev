import { logger, task } from "@trigger.dev/sdk";

/**
 * Echo task — returns its payload unchanged. Used as the trigger target for
 * the external multi-client scripts and the fan-out task in this reference
 * project.
 */
export const echo = task({
  id: "echo",
  run: async (payload: { from: string; note?: string }, { ctx }) => {
    logger.info("echo received", { payload, ctx });
    return {
      received: payload,
      runId: ctx.run.id,
      environmentSlug: ctx.environment.slug,
      branch: ctx.environment.branchName ?? null,
    };
  },
});
