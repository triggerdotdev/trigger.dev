import sharp from "sharp";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { AVIF_EFFORT, PRESETS, SAMPLES, VARIANTS } from "../shared/catalog";
import type { SampleId, PresetId, VariantKind } from "../shared/types";

sharp.concurrency(1);

export async function encodeVariant(input: Uint8Array, preset: PresetId, kind: VariantKind) {
  const settings = PRESETS.find((candidate) => candidate.id === preset);
  const variant = VARIANTS.find((candidate) => candidate.kind === kind);
  if (!settings || !variant) throw new Error("Unknown preset or output");
  const data = await sharp(input, { limitInputPixels: 12_000_000 })
    .rotate()
    .resize(variant.width, variant.height, { fit: "cover" })
    .avif({ quality: settings.quality, effort: AVIF_EFFORT })
    .toBuffer();
  return {
    kind: variant.kind,
    width: variant.width,
    height: variant.height,
    format: "avif" as const,
    bytes: data.byteLength,
    data,
  };
}

export async function createImageSet(
  sample: SampleId,
  preset: PresetId,
  report: (stage: string, progress: number) => Promise<void> = async () => {}
) {
  const source = SAMPLES.find((candidate) => candidate.id === sample);
  const settings = PRESETS.find((candidate) => candidate.id === preset);
  if (!source || !settings) throw new Error("Unknown sample or preset");
  const input = await readFile(resolve(process.cwd(), "public", source.file.slice(1)));
  const start = performance.now();
  const variants = [];
  for (const [index, variant] of VARIANTS.entries()) {
    await report(
      `Trigger: cropping and compressing ${variant.width} × ${variant.height}`,
      10 + index * 25
    );
    variants.push(await encodeVariant(input, preset, variant.kind));
  }
  return {
    variants,
    inputBytes: input.byteLength,
    processingMs: Math.round(performance.now() - start),
  };
}
