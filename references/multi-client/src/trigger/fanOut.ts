import { logger, task, TriggerClient } from "@trigger.dev/sdk";

/**
 * Fan-out task — runs inside a task, constructs two `TriggerClient`
 * instances with different configs, and fires `echo` through each.
 *
 * The point: instance calls are isolated from the surrounding task
 * runtime. Even though we're inside a task with a parent run id and
 * lockToVersion in `taskContext`, the instance calls do NOT propagate
 * those automatically — they go out as clean external triggers.
 *
 * Set TRIGGER_FAN_OUT_PRIMARY_KEY and TRIGGER_FAN_OUT_SECONDARY_KEY env
 * vars in the trigger dashboard (or in the dev env if running locally)
 * to point each client at a different secret. Optionally set
 * TRIGGER_FAN_OUT_SECONDARY_BRANCH to send the second one to a preview
 * branch.
 */
export const fanOut = task({
  id: "fan-out",
  run: async (
    _: { note?: string },
    { ctx }
  ) => {
    logger.info("fan-out running inside task", {
      runId: ctx.run.id,
      env: ctx.environment.slug,
      branch: ctx.environment.branchName,
    });

    const primaryKey = process.env.TRIGGER_FAN_OUT_PRIMARY_KEY;
    const secondaryKey = process.env.TRIGGER_FAN_OUT_SECONDARY_KEY;
    const secondaryBranch = process.env.TRIGGER_FAN_OUT_SECONDARY_BRANCH;

    if (!primaryKey || !secondaryKey) {
      logger.warn(
        "fan-out skipped — set TRIGGER_FAN_OUT_PRIMARY_KEY and TRIGGER_FAN_OUT_SECONDARY_KEY to exercise the multi-client path"
      );
      return { skipped: true };
    }

    const primary = new TriggerClient({ accessToken: primaryKey });
    const secondary = new TriggerClient({
      accessToken: secondaryKey,
      previewBranch: secondaryBranch,
    });

    // The instance methods are isolated: taskContext.ctx is masked inside
    // the scope, so neither call inherits parentRunId / lockToVersion / etc.
    const [a, b] = await Promise.all([
      primary.tasks.trigger("echo", {
        from: "fan-out via primary client",
        note: `parent run was ${ctx.run.id}`,
      }),
      secondary.tasks.trigger("echo", {
        from: "fan-out via secondary client",
        note: `branch: ${secondaryBranch ?? "(none)"}`,
      }),
    ]);

    return {
      primary: { id: a.id, taskIdentifier: a.taskIdentifier },
      secondary: { id: b.id, taskIdentifier: b.taskIdentifier },
    };
  },
});
