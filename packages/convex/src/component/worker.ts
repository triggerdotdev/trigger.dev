import { v } from "convex/values";
import { internal } from "./api.js";
import { internalAction, internalMutation } from "./server.js";
import { pause } from "./runs.js";
import { ApiError, inlineValue, request } from "./apiClient.js";
import {
  IDEMPOTENCY_TTL,
  MAX_SYNC_FAILURES,
  REQUEST_TIMEOUT_MS,
  SUBMISSION_WINDOW_MS,
  WATCHDOG_MARGIN_MS,
  pollDelay,
} from "./shared.js";

const jobArgs = { id: v.id("runs"), generation: v.number() };

export const tick = internalMutation({
  args: jobArgs,
  returns: v.null(),
  handler: async (ctx, { id, generation }): Promise<null> => {
    const run = await ctx.db.get("runs", id);
    if (
      !run ||
      run.generation !== generation ||
      run.syncStatus === "complete" ||
      run.syncStatus === "paused"
    )
      return null;
    if (!run.runId && Date.now() - run._creationTime >= SUBMISSION_WINDOW_MS) {
      await pause(
        ctx,
        run,
        "Submission retry window expired; check Trigger before triggering again"
      );
      return null;
    }
    const nextGeneration = generation + 1;
    await ctx.db.patch("runs", id, { generation: nextGeneration, checks: run.checks + 1 });
    // Schedule the watchdog transactionally before starting an action that can be interrupted.
    await ctx.scheduler.runAfter(
      Math.max(pollDelay(run.checks), REQUEST_TIMEOUT_MS + WATCHDOG_MARGIN_MS),
      internal.worker.tick,
      { id, generation: nextGeneration }
    );
    await ctx.scheduler.runAfter(0, internal.worker.step, { id, generation: nextGeneration });
    return null;
  },
});

export const step = internalAction({
  args: jobArgs,
  returns: v.null(),
  handler: async (ctx, { id, generation }): Promise<null> => {
    const loaded = await ctx.runQuery(internal.runs.load, { id });
    if (
      !loaded ||
      loaded.run.generation !== generation ||
      loaded.run.syncStatus === "complete" ||
      loaded.run.syncStatus === "paused"
    )
      return null;
    const { run, request: saved } = loaded;
    try {
      if (!run.runId) {
        const result = await request(
          saved.config,
          `/api/v1/tasks/${encodeURIComponent(run.taskId)}/trigger`,
          {
            payload: saved.payload,
            options: {
              ...saved.options,
              idempotencyKey: `convex:${id}`,
              idempotencyKeyTTL: IDEMPOTENCY_TTL,
            },
          }
        );
        if (typeof result.id !== "string")
          throw new ApiError("Missing run ID in Trigger.dev response", true);
        await ctx.runMutation(internal.runs.recordSubmission, { id, generation, runId: result.id });
      } else {
        const result = await request(saved.config, `/api/v3/runs/${encodeURIComponent(run.runId)}`);
        if (typeof result.status !== "string" || typeof result.isCompleted !== "boolean") {
          throw new ApiError("Missing run status in Trigger.dev response", true);
        }
        const output = inlineValue(result.output);
        await ctx.runMutation(internal.runs.recordStatus, {
          id,
          generation,
          status: result.status,
          completed:
            result.isCompleted || result.status === "EXPIRED" || result.status === "TIMED_OUT",
          output: output.value,
          outputOmitted: output.omitted,
          outputPresignedUrl:
            typeof result.outputPresignedUrl === "string" ? result.outputPresignedUrl : undefined,
          error: inlineValue(result.error).value,
          metadata: inlineValue(result.metadata).value,
        });
      }
    } catch (error) {
      await ctx.runMutation(internal.worker.recordError, {
        id,
        generation,
        message:
          error instanceof ApiError
            ? error.message
            : "Run synchronization failed; inspect Convex function logs",
        permanent: error instanceof ApiError && !error.retryable,
      });
      // Preserve diagnostic detail in server logs without including the request config.
      console.error("Trigger.dev synchronization failed", {
        id,
        error: error instanceof Error ? error.name : "UnknownError",
      });
    }
    return null;
  },
});

export const recordError = internalMutation({
  args: { ...jobArgs, message: v.string(), permanent: v.boolean() },
  returns: v.null(),
  handler: async (ctx, { id, generation, message, permanent }): Promise<null> => {
    const run = await ctx.db.get("runs", id);
    if (!run || run.generation !== generation || run.syncStatus === "complete") return null;
    const failures = run.failures + 1;
    await ctx.db.patch("runs", id, { failures, syncError: message, updatedAt: Date.now() });
    if (permanent || failures >= MAX_SYNC_FAILURES) await pause(ctx, run, message);
    return null;
  },
});
