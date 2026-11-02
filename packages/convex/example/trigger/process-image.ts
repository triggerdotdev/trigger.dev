import { logger, metadata, schemaTask } from "@trigger.dev/sdk";
import { z } from "zod";
import { PROMPT_LIMIT, VARIANTS } from "../shared/catalog";
import { workerSchema } from "./artifacts";
import { prepareImage, editImage, exportImage, sampleSchema, presetSchema } from "./steps";

async function report(
  phase: "prepare" | "edit" | "finish" | "ready",
  stage: string,
  progress: number
) {
  metadata.set("phase", phase).set("stage", stage).set("progress", progress);
  await metadata.flush().catch(() => logger.warn("Progress update unavailable"));
}

export const processImage = schemaTask({
  id: "convex-edit-image",
  schema: workerSchema.extend({
    sample: sampleSchema,
    preset: presetSchema,
    prompt: z.string().trim().min(1).max(PROMPT_LIMIT),
  }),
  queue: { name: "convex-image-pipeline", concurrencyLimit: 1 },
  machine: "small-1x",
  maxDuration: 120,
  retry: { maxAttempts: 1 },
  run: async (payload) => {
    if (!process.env.AI_GATEWAY_API_KEY)
      throw new Error("Add AI_GATEWAY_API_KEY to the Trigger project before enabling image edits.");
    const started = Date.now();
    const worker = {
      serviceUrl: payload.serviceUrl,
      jobId: payload.jobId,
    };
    await report("prepare", "Preparing the photograph", 5);
    const prepared = await prepareImage
      .triggerAndWait(
        { ...worker, sample: payload.sample },
        {
          idempotencyKey: `${payload.jobId}:prepare`,
          ttl: "5m",
        }
      )
      .unwrap();
    await report("edit", "Editing with the Muse image model", 25);
    await editImage
      .triggerAndWait(
        { ...worker, prompt: payload.prompt },
        {
          idempotencyKey: `${payload.jobId}:model`,
          ttl: "5m",
        }
      )
      .unwrap();
    await report("finish", "Exporting three images in parallel", 65);
    const batch = await exportImage.batchTriggerAndWait(
      VARIANTS.map((variant) => ({
        payload: { ...worker, preset: payload.preset, kind: variant.kind },
        options: { idempotencyKey: `${payload.jobId}:export:${variant.kind}`, ttl: "5m" },
      }))
    );
    const variants = batch.runs.map((run) => {
      if (!run.ok)
        throw new Error("An image export failed. The paid edit will not be retried automatically.");
      return run.output;
    });
    for (const variant of VARIANTS) metadata.set(`${variant.kind}Ready`, true);
    await report("ready", "Images ready", 100);
    return { inputBytes: prepared.inputBytes, processingMs: Date.now() - started, variants };
  },
});
