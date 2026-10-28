import {
  paginationOptsValidator,
  type FunctionHandle,
  type GenericMutationCtx,
} from "convex/server";
import { v } from "convex/values";
import { internal } from "./api.js";
import { internalMutation, internalQuery, mutation, query, type DataModel } from "./server.js";
import {
  MAX_INLINE_BYTES,
  MAX_PAGE_BYTES,
  SUBMISSION_WINDOW_MS,
  vConfig,
  vRun,
  vTriggerOptions,
  type Run,
} from "./shared.js";

type RunDoc = DataModel["runs"]["document"];

export function toRun(run: RunDoc): Run {
  const { _id, _creationTime, generation, checks, failures, callback, ...fields } = run;
  return { id: _id, createdAt: _creationTime, ...fields };
}

export const trigger = mutation({
  args: {
    taskId: v.string(),
    payload: v.optional(v.any()),
    options: vTriggerOptions,
    config: vConfig,
    idempotencyKey: v.optional(v.string()),
    callback: v.optional(v.string()),
  },
  returns: v.string(),
  handler: async (ctx, args): Promise<string> => {
    if (!args.taskId.trim()) throw new Error("taskId is required");
    if (
      new TextEncoder().encode(JSON.stringify({ payload: args.payload, options: args.options }))
        .byteLength > MAX_INLINE_BYTES
    ) {
      throw new Error(
        "Payload and options must fit within 256 KiB; pass a storage reference for larger inputs"
      );
    }
    if (args.idempotencyKey !== undefined) {
      const existing = await ctx.db
        .query("runs")
        .withIndex("by_key", (q) => q.eq("idempotencyKey", args.idempotencyKey))
        .unique();
      if (existing) return existing._id;
    }
    const id = await ctx.db.insert("runs", {
      taskId: args.taskId,
      idempotencyKey: args.idempotencyKey,
      status: "PENDING",
      syncStatus: "pending",
      updatedAt: Date.now(),
      generation: 0,
      checks: 0,
      failures: 0,
      callback: args.callback,
    });
    await ctx.db.insert("requests", {
      run: id,
      payload: args.payload,
      options: args.options,
      config: args.config,
    });
    await ctx.scheduler.runAfter(0, internal.worker.tick, { id, generation: 0 });
    return id;
  },
});

export const get = query({
  args: { id: v.string() },
  returns: v.union(vRun, v.null()),
  handler: async (ctx, { id }): Promise<Run | null> => {
    const runId = ctx.db.normalizeId("runs", id);
    const run = runId ? await ctx.db.get("runs", runId) : null;
    return run ? toRun(run) : null;
  },
});

export const list = query({
  args: { paginationOpts: paginationOptsValidator },
  returns: v.object({ page: v.array(vRun), isDone: v.boolean(), continueCursor: v.string() }),
  handler: async (
    ctx,
    { paginationOpts }
  ): Promise<{ page: Run[]; isDone: boolean; continueCursor: string }> => {
    if (paginationOpts.numItems < 1 || paginationOpts.numItems > 100) {
      throw new Error("Request between 1 and 100 runs per page");
    }
    const result = await ctx.db
      .query("runs")
      .order("desc")
      .paginate({
        ...paginationOpts,
        maximumBytesRead: Math.min(
          paginationOpts.maximumBytesRead ?? MAX_PAGE_BYTES,
          MAX_PAGE_BYTES
        ),
      });
    return {
      page: result.page.map(toRun),
      isDone: result.isDone,
      continueCursor: result.continueCursor,
    };
  },
});

export const resume = mutation({
  args: { id: v.string(), config: vConfig },
  returns: v.null(),
  handler: async (ctx, { id, config }): Promise<null> => {
    const runId = ctx.db.normalizeId("runs", id);
    const run = runId ? await ctx.db.get("runs", runId) : null;
    if (!run) throw new Error("Run not found");
    if (run.syncStatus !== "paused") return null;
    if (!run.runId && Date.now() - run._creationTime >= SUBMISSION_WINDOW_MS) {
      throw new Error(
        "Submission retry window expired; reconcile the run in Trigger before triggering again"
      );
    }
    const request = await ctx.db
      .query("requests")
      .withIndex("by_run", (q) => q.eq("run", run._id))
      .unique();
    if (!request) throw new Error("Run request not found");
    await ctx.db.patch("requests", request._id, { config });
    const generation = run.generation + 1;
    await ctx.db.patch("runs", run._id, {
      syncStatus: run.runId ? "active" : "pending",
      syncError: undefined,
      failures: 0,
      checks: 0,
      generation,
      updatedAt: Date.now(),
    });
    await ctx.scheduler.runAfter(0, internal.worker.tick, { id: run._id, generation });
    return null;
  },
});

export const load = internalQuery({
  args: { id: v.id("runs") },
  handler: async (ctx, { id }) => {
    const run = await ctx.db.get("runs", id);
    const request = await ctx.db
      .query("requests")
      .withIndex("by_run", (q) => q.eq("run", id))
      .unique();
    return run && request ? { run, request } : null;
  },
});

export const recordSubmission = internalMutation({
  args: { id: v.id("runs"), generation: v.number(), runId: v.string() },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const run = await ctx.db.get("runs", args.id);
    if (!run || run.generation !== args.generation || run.syncStatus === "complete") return null;
    await ctx.db.patch("runs", args.id, {
      runId: args.runId,
      status: "QUEUED",
      syncStatus: "active",
      syncError: undefined,
      failures: 0,
      checks: 0,
      updatedAt: Date.now(),
    });
    return null;
  },
});

export const recordStatus = internalMutation({
  args: {
    id: v.id("runs"),
    generation: v.number(),
    status: v.string(),
    completed: v.boolean(),
    output: v.optional(v.any()),
    outputPresignedUrl: v.optional(v.string()),
    outputOmitted: v.optional(v.boolean()),
    error: v.optional(v.any()),
    metadata: v.optional(v.any()),
  },
  returns: v.null(),
  handler: async (ctx, { id, generation, completed, ...result }): Promise<null> => {
    const run = await ctx.db.get("runs", id);
    if (!run || run.generation !== generation || run.syncStatus === "complete") return null;
    const updates = {
      ...result,
      syncStatus: completed ? ("complete" as const) : ("active" as const),
      syncError: undefined,
      failures: 0,
      updatedAt: Date.now(),
    };
    await ctx.db.patch("runs", id, updates);
    if (completed) {
      if (run.callback) {
        await ctx.runMutation(run.callback as FunctionHandle<"mutation", { run: Run }>, {
          run: toRun({ ...run, ...updates }),
        });
      }
      const request = await ctx.db
        .query("requests")
        .withIndex("by_run", (q) => q.eq("run", id))
        .unique();
      if (request) await ctx.db.delete("requests", request._id);
    }
    return null;
  },
});

export async function pause(
  ctx: GenericMutationCtx<DataModel>,
  run: RunDoc,
  message: string
): Promise<void> {
  await ctx.db.patch("runs", run._id, {
    syncStatus: "paused",
    syncError: message,
    updatedAt: Date.now(),
  });
}
