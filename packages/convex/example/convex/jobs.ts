import { vRun } from "@trigger.dev/convex";
import { v } from "convex/values";
import { action, mutation, query, internalMutation, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";
import { trigger } from "./trigger";
import { vSample, vPreset, vSlot } from "./schema";
import { digest, ownedEdit, ownerHash } from "./auth";
import { jobWorkerToken } from "../shared/workerAuth";
import {
  COOLDOWN_MS,
  MAX_JOBS,
  DAILY_JOB_LIMIT,
  PROMPT_LIMIT,
  RESULT_TTL_MS,
  PROCESSOR_VERSION,
} from "../shared/catalog";
import { outputSchema } from "../shared/output";
import type { Board } from "../shared/types";
import type { processImage } from "../trigger/process-image";

const DAY_MS = 24 * 60 * 60_000;
const CLEANUP_BATCH_SIZE = 100;
const requestArgs = {
  sessionToken: v.string(),
  sample: vSample,
  preset: vPreset,
  prompt: v.string(),
  requestId: v.string(),
};
type ProcessResult = { jobId: string; cached: boolean };

export const board = query({
  args: { sessionToken: v.string() },
  handler: async (ctx, { sessionToken }): Promise<Board> => {
    const owner = await ownerHash(sessionToken);
    const control = await ctx.db.query("launchControl").unique();
    const records = await ctx.db
      .query("edits")
      .withIndex("by_owner", (q) => q.eq("ownerHash", owner).gt("expiresAt", Date.now()))
      .order("desc")
      .take(20);
    const jobs = await Promise.all(
      records.map(async (record) => {
        const run = record.componentRunId ? await trigger.getRun(ctx, record.componentRunId) : null;
        const exportCount = record.files.filter(
          (file) => !["prepared", "edited"].includes(file.slot)
        ).length;
        const artifactProgress = exportCount
          ? 65 + exportCount * 10
          : record.files.some((file) => file.slot === "edited")
            ? 65
            : record.files.length
              ? 25
              : 0;
        const reportedProgress = Math.max(0, Math.min(95, Number(run?.metadata?.progress) || 0));
        const artifactStage = exportCount
          ? `${exportCount} of 3 parallel exports ready; waiting for completion`
          : artifactProgress === 65
            ? "Model edit ready; parallel exports next"
            : "Photograph prepared; image model edit next";
        const observedStatus =
          record.files.length && ["PENDING", "QUEUED"].includes(run?.status ?? "PENDING")
            ? "EXECUTING"
            : run?.status;
        const status = record.finalStatus ?? observedStatus ?? "PENDING";
        return {
          id: record._id,
          requestId: record.requestId,
          sample: record.sample,
          preset: record.preset,
          prompt: record.prompt,
          createdAt: record._creationTime,
          completedAt: record.completedAt,
          expiresAt: record.expiresAt,
          status,
          syncStatus: run?.syncStatus ?? "pending",
          runId: run?.runId ?? null,
          realtimeEligible: record.realtimeEligible === true,
          progress:
            record.finalStatus === "COMPLETED" ? 100 : Math.max(reportedProgress, artifactProgress),
          stage: record.deliveryError
            ? "Result verification failed"
            : record.finalStatus === "COMPLETED"
              ? "Images ready"
              : record.finalStatus
                ? "Workflow stopped"
                : Number(run?.metadata?.progress) >= 100
                  ? "Verifying exported images"
                  : artifactProgress > reportedProgress
                    ? artifactStage
                    : String(run?.metadata?.stage ?? "Waiting for Trigger"),
          error:
            record.deliveryError ??
            (run?.syncError
              ? "Status synchronization paused. An operator needs to resume this job."
              : record.finalStatus && status !== "COMPLETED"
                ? "The job did not finish. No automatic paid retry was made."
                : null),
          results: (record.variants ?? []).map((variant) => ({
            ...variant,
            url: `${globalThis.process.env.CONVEX_SITE_URL}/api/image?jobId=${record._id}&slot=${variant.kind}`,
          })),
          inputBytes: record.inputBytes,
          processingMs: record.processingMs,
        };
      })
    );
    const today = Math.floor(Date.now() / DAY_MS) * DAY_MS;
    return {
      jobs,
      quota: {
        used: control?.modelUsed ?? 0,
        limit: MAX_JOBS,
        dailyUsed: control?.dayStart === today ? (control.dayUsed ?? 0) : 0,
        dailyLimit: DAILY_JOB_LIMIT,
        active: !!control?.activeEdit,
        enabled: globalThis.process.env.DEMO_ENABLED === "true",
        cooldownUntil: control ? control.lastLaunchAt + COOLDOWN_MS : 0,
      },
      turnstileSiteKey: globalThis.process.env.TURNSTILE_SITE_KEY ?? null,
    };
  },
});

export const existingRequest = internalQuery({
  args: requestArgs,
  handler: async (ctx, args): Promise<ProcessResult | null> => {
    const owner = await ownerHash(args.sessionToken);
    const existing = await ctx.db
      .query("edits")
      .withIndex("by_request", (q) => q.eq("ownerHash", owner).eq("requestId", args.requestId))
      .unique();
    if (!existing) return null;
    if (
      existing.sample !== args.sample ||
      existing.preset !== args.preset ||
      existing.prompt !== args.prompt.trim()
    )
      throw new Error("Request identifier already used for different edits");
    return { jobId: existing._id, cached: true };
  },
});

export const process = action({
  args: { ...requestArgs, challengeToken: v.optional(v.string()) },
  handler: async (ctx, { challengeToken, ...args }): Promise<ProcessResult> => {
    await ownerHash(args.sessionToken);
    if (!args.prompt.trim() || args.prompt.length > PROMPT_LIMIT)
      throw new Error(`Enter an edit instruction of at most ${PROMPT_LIMIT} characters.`);
    if (!/^[a-zA-Z0-9-]{8,64}$/.test(args.requestId)) throw new Error("Invalid request identifier");
    const existing = await ctx.runQuery(internal.jobs.existingRequest, args);
    if (existing) return existing;
    const siteKey = globalThis.process.env.TURNSTILE_SITE_KEY;
    const secret = globalThis.process.env.TURNSTILE_SECRET_KEY;
    if (siteKey || secret) {
      if (!siteKey || !secret) throw new Error("Human verification is not configured correctly.");
      if (!challengeToken || challengeToken.length > 2048)
        throw new Error("Complete human verification first.");
      let verified = false;
      try {
        const response = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
          method: "POST",
          body: new URLSearchParams({ secret, response: challengeToken }),
          signal: AbortSignal.timeout(10_000),
        });
        const result = await response.json();
        verified =
          response.ok &&
          result.success === true &&
          result.hostname === new URL(globalThis.process.env.CONVEX_SITE_URL!).hostname;
      } catch {
        /* Verification fails closed; a retry must not create duplicate paid work. */
      }
      if (!verified) {
        const received = await ctx.runQuery(internal.jobs.existingRequest, args);
        if (received) return received;
        throw new Error("Human verification failed. Please try again.");
      }
    }
    return ctx.runMutation(internal.jobs.reserve, args);
  },
});

export const reserve = internalMutation({
  args: requestArgs,
  handler: async (
    ctx,
    { sessionToken, sample, preset, prompt: rawPrompt, requestId }
  ): Promise<ProcessResult> => {
    const owner = await ownerHash(sessionToken);
    const prompt = rawPrompt.trim();
    if (!prompt || prompt.length > PROMPT_LIMIT || !/^[a-zA-Z0-9-]{8,64}$/.test(requestId))
      throw new Error("Invalid edit request");
    const existing = await ctx.db
      .query("edits")
      .withIndex("by_request", (q) => q.eq("ownerHash", owner).eq("requestId", requestId))
      .unique();
    if (existing) {
      if (existing.sample !== sample || existing.preset !== preset || existing.prompt !== prompt)
        throw new Error("Request identifier already used for different edits");
      return { jobId: existing._id, cached: true };
    }
    const key = await digest(JSON.stringify([PROCESSOR_VERSION, sample, preset, prompt]));
    const cached = await ctx.db
      .query("edits")
      .withIndex("by_key", (q) => q.eq("ownerHash", owner).eq("key", key))
      .order("desc")
      .first();
    if (
      cached &&
      cached.expiresAt > Date.now() &&
      (!cached.finalStatus || cached.finalStatus === "COMPLETED")
    )
      return { jobId: cached._id, cached: true };
    if (globalThis.process.env.DEMO_ENABLED !== "true")
      throw new Error("New image edits are paused while the demo is being configured.");
    const control = await ctx.db.query("launchControl").unique();
    const used = control?.modelUsed ?? 0;
    const dayStart = Math.floor(Date.now() / DAY_MS) * DAY_MS;
    const dayUsed = control?.dayStart === dayStart ? (control.dayUsed ?? 0) : 0;
    if (used >= MAX_JOBS) throw new Error("The demo's lifetime generation budget is exhausted.");
    if (dayUsed >= DAILY_JOB_LIMIT)
      throw new Error("Today's generation budget is exhausted. Please come back tomorrow.");
    if (control?.activeEdit)
      throw new Error("Another background job is running. Please wait for it to finish.");
    if (control && Date.now() < control.lastLaunchAt + COOLDOWN_MS)
      throw new Error("Please wait for the shared cooldown.");
    const serviceUrl = globalThis.process.env.CONVEX_SITE_URL;
    if (!serviceUrl) throw new Error("The image service is not configured.");
    const jobId = await ctx.db.insert("edits", {
      ownerHash: owner,
      workerHash: "",
      realtimeEligible: true,
      sample,
      preset,
      prompt,
      requestId,
      key,
      expiresAt: Date.now() + RESULT_TTL_MS,
      files: [],
    });
    const componentRunId = await trigger.trigger<typeof processImage>(
      ctx,
      "convex-edit-image",
      {
        sample,
        preset,
        prompt,
        jobId,
        serviceUrl,
      },
      { idempotencyKey: `edit:${jobId}`, tags: ["convex-image-demo"], ttl: "5m" }
    );
    const workerToken = await jobWorkerToken(globalThis.process.env.DEMO_ARTIFACT_SECRET, jobId);
    await ctx.db.patch(jobId, { componentRunId, workerHash: await digest(workerToken) });
    const next = {
      modelUsed: used + 1,
      dayStart,
      dayUsed: dayUsed + 1,
      lastLaunchAt: Date.now(),
      activeEdit: jobId,
    };
    if (control) await ctx.db.patch(control._id, next);
    else await ctx.db.insert("launchControl", { used: 0, ...next });
    await ctx.scheduler.runAfter(RESULT_TTL_MS, internal.jobs.expire, { jobId });
    return { jobId, cached: false };
  },
});

export const refresh = mutation({
  args: { jobId: v.id("edits"), sessionToken: v.string() },
  handler: async (ctx, { jobId, sessionToken }): Promise<null> => {
    const job = await ownedEdit(ctx, jobId, sessionToken);
    if (job.componentRunId && !job.finalStatus) await trigger.refresh(ctx, job.componentRunId);
    return null;
  },
});

export const realtimeAccess = internalQuery({
  args: { jobId: v.id("edits"), sessionToken: v.string() },
  handler: async (ctx, { jobId, sessionToken }) => {
    const job = await ownedEdit(ctx, jobId, sessionToken);
    // Old runs may contain a worker credential in their payload and must never get browser tokens.
    if (!job.realtimeEligible || !job.componentRunId) return null;
    const run = await trigger.getRun(ctx, job.componentRunId);
    if (!run?.runId) return null;
    return { runId: run.runId, cached: job.realtimeToken ?? null, expiresAt: job.expiresAt };
  },
});

export const cacheRealtimeToken = internalMutation({
  args: {
    jobId: v.id("edits"),
    sessionToken: v.string(),
    runId: v.string(),
    accessToken: v.string(),
    expiresAt: v.number(),
  },
  handler: async (ctx, args): Promise<null> => {
    const job = await ownedEdit(ctx, args.jobId, args.sessionToken);
    if (!job.realtimeEligible) return null;
    const run = job.componentRunId ? await trigger.getRun(ctx, job.componentRunId) : null;
    if (run?.runId !== args.runId) throw new Error("Run changed");
    await ctx.db.patch(job._id, {
      realtimeToken: {
        runId: args.runId,
        accessToken: args.accessToken,
        expiresAt: args.expiresAt,
      },
    });
    return null;
  },
});

export const fileAccess = internalQuery({
  args: { jobId: v.id("edits"), token: v.string(), slot: vSlot, write: v.boolean() },
  handler: async (ctx, { jobId, token, slot, write }) => {
    if (!/^[a-f0-9]{64}$/.test(token)) return null;
    const job = await ctx.db.get(jobId);
    if (!job || job.expiresAt <= Date.now()) return null;
    const hash = await digest(token);
    const worker = hash === job.workerHash;
    if (
      write
        ? !worker || !!job.finalStatus
        : !worker && (hash !== job.ownerHash || slot === "prepared" || slot === "edited")
    )
      return null;
    return { storageId: job.files.find((file) => file.slot === slot)?.storageId ?? null };
  },
});

export const registerFile = internalMutation({
  args: { jobId: v.id("edits"), token: v.string(), slot: vSlot, storageId: v.id("_storage") },
  handler: async (ctx, { jobId, token, slot, storageId }): Promise<boolean> => {
    const job = await ctx.db.get(jobId);
    if (
      !job ||
      job.expiresAt <= Date.now() ||
      job.finalStatus ||
      (await digest(token)) !== job.workerHash
    )
      return false;
    if (job.files.some((file) => file.slot === slot)) await ctx.storage.delete(storageId);
    else await ctx.db.patch(jobId, { files: [...job.files, { slot, storageId }] });
    return true;
  },
});

export const expire = internalMutation({
  args: { jobId: v.id("edits") },
  handler: async (ctx, { jobId }): Promise<null> => {
    const job = await ctx.db.get(jobId);
    if (!job) return null;
    if (job.expiresAt > Date.now()) throw new Error("Job has not expired");
    for (const file of job.files) await ctx.storage.delete(file.storageId);
    const control = await ctx.db.query("launchControl").unique();
    if (control?.activeEdit === jobId) await ctx.db.patch(control._id, { activeEdit: undefined });
    await ctx.db.delete(jobId);
    return null;
  },
});

export const sweepStorage = internalMutation({
  args: {},
  handler: async (ctx): Promise<null> => {
    // Root storage is reserved for image artifacts; static hosting uses isolated component storage.
    const files = await ctx.db.system
      .query("_storage")
      .withIndex("by_creation_time", (q) => q.lt("_creationTime", Date.now() - RESULT_TTL_MS))
      .take(CLEANUP_BATCH_SIZE);
    for (const file of files) await ctx.storage.delete(file._id);
    if (files.length === CLEANUP_BATCH_SIZE)
      await ctx.scheduler.runAfter(0, internal.jobs.sweepStorage, {});
    return null;
  },
});

export const resume = internalMutation({
  args: { jobId: v.id("edits") },
  handler: async (ctx, { jobId }): Promise<null> => {
    const job = await ctx.db.get(jobId);
    if (!job?.componentRunId || job.finalStatus)
      throw new Error("Job is missing or already finished");
    return trigger.resume(ctx, job.componentRunId);
  },
});

export const complete = internalMutation({
  args: { run: vRun },
  handler: async (ctx, { run }): Promise<null> => {
    const job = await ctx.db
      .query("edits")
      .withIndex("by_run", (q) => q.eq("componentRunId", run.id))
      .unique();
    if (!job || job.finalStatus) return null;
    let deliveryError: string | undefined;
    let output: ReturnType<typeof outputSchema.parse> | undefined;
    if (run.status === "COMPLETED") {
      try {
        output = outputSchema.parse(run.output);
        for (const variant of output.variants) {
          const file = job.files.find((file) => file.slot === variant.kind);
          const info = file ? await ctx.db.system.get(file.storageId) : null;
          if (!info || info.size !== variant.bytes || info.contentType !== "image/avif")
            throw new Error("Missing image");
        }
      } catch {
        output = undefined;
        deliveryError = "Processing finished, but the generated files could not be verified.";
      }
    }
    const successful = !!output;
    const retained = [];
    for (const file of job.files) {
      if (!successful || file.slot === "prepared" || file.slot === "edited")
        await ctx.storage.delete(file.storageId);
      else retained.push(file);
    }
    await ctx.db.patch(job._id, {
      finalStatus: deliveryError ? "FAILED" : run.status,
      deliveryError,
      completedAt: Date.now(),
      files: retained,
      ...(output
        ? {
            variants: output.variants,
            inputBytes: output.inputBytes,
            processingMs: output.processingMs,
          }
        : {}),
    });
    const control = await ctx.db.query("launchControl").unique();
    if (control?.activeEdit === job._id) await ctx.db.patch(control._id, { activeEdit: undefined });
    return null;
  },
});
