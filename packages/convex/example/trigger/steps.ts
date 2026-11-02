import { logger, metadata, schemaTask } from "@trigger.dev/sdk";
import { z } from "zod";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import sharp from "sharp";
import { SAMPLES, PRESETS, PROMPT_LIMIT } from "../shared/catalog";
import { workerSchema, readArtifact, saveArtifact } from "./artifacts";
import { editWithModel } from "./model";
import { encodeVariant } from "./processor";

sharp.concurrency(1);
export const sampleSchema = z.enum(SAMPLES.map((sample) => sample.id));
export const presetSchema = z.enum(PRESETS.map((preset) => preset.id));

export const prepareImage = schemaTask({
  id: "convex-image-prepare",
  schema: workerSchema.extend({ sample: sampleSchema }),
  queue: { name: "convex-image-prepare", concurrencyLimit: 1 },
  machine: "small-1x",
  maxDuration: 60,
  retry: { maxAttempts: 1 },
  run: async (payload) => {
    const source = SAMPLES.find((sample) => sample.id === payload.sample)!;
    const bytes = await readFile(resolve(process.cwd(), "public", source.file.slice(1)));
    const prepared = await sharp(bytes, { limitInputPixels: 12_000_000 })
      .rotate()
      .resize({ width: 1024, height: 1024, fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: 85 })
      .toBuffer();
    await saveArtifact(payload, "prepared", prepared);
    return { inputBytes: bytes.byteLength };
  },
});

export const editImage = schemaTask({
  id: "convex-image-model-edit",
  schema: workerSchema.extend({ prompt: z.string().trim().min(1).max(PROMPT_LIMIT) }),
  queue: { name: "convex-image-model", concurrencyLimit: 1 },
  machine: "small-1x",
  maxDuration: 120,
  retry: { maxAttempts: 1 },
  run: async (payload) => {
    const input = await readArtifact(payload, "prepared");
    const edited = await editWithModel(input, payload.prompt);
    await saveArtifact(payload, "edited", edited);
    return { edited: true };
  },
});

export const exportImage = schemaTask({
  id: "convex-image-export",
  schema: workerSchema.extend({ preset: presetSchema, kind: z.enum(["hero", "card", "square"]) }),
  queue: { name: "convex-image-exports", concurrencyLimit: 3 },
  machine: "small-1x",
  maxDuration: 90,
  retry: { maxAttempts: 1 },
  run: async (payload) => {
    const input = await readArtifact(payload, "edited");
    const { data, ...result } = await encodeVariant(input, payload.preset, payload.kind);
    await saveArtifact(payload, payload.kind, data);
    metadata.parent.set(`${payload.kind}Ready`, true);
    await metadata.flush().catch(() => logger.warn("Parent progress update unavailable"));
    return result;
  },
});
