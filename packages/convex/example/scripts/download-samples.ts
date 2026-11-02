import { mkdir, writeFile, readFile } from "node:fs/promises";
import sharp from "sharp";
import { SAMPLES } from "../shared/catalog.ts";

const MAX_SAMPLE_EDGE = 1600;
const resizeOnly = process.argv.includes("--resize-only");
await mkdir(new URL("../public/samples/", import.meta.url), { recursive: true });
for (const sample of SAMPLES) {
  const file = new URL(`../public/samples/${sample.id}.jpg`, import.meta.url);
  let bytes: Uint8Array;
  if (resizeOnly) {
    bytes = await readFile(file);
    const metadata = await sharp(bytes).metadata();
    if (metadata.width! <= MAX_SAMPLE_EDGE && metadata.height! <= MAX_SAMPLE_EDGE) continue;
  } else {
    const response = await fetch(`${sample.source}?fit=max&w=1600&h=1600&q=85&fm=jpg`, {
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok || !response.headers.get("content-type")?.startsWith("image/"))
      throw new Error(`Could not fetch ${sample.id}`);
    bytes = new Uint8Array(await response.arrayBuffer());
  }
  if (bytes.byteLength > 5 * 1024 * 1024) throw new Error("Sample is too large");
  const normalized = await sharp(bytes, { limitInputPixels: 12_000_000 })
    .rotate()
    .resize({
      width: MAX_SAMPLE_EDGE,
      height: MAX_SAMPLE_EDGE,
      fit: "inside",
      withoutEnlargement: true,
    })
    .jpeg({ quality: 85 })
    .toBuffer();
  await writeFile(file, normalized);
  console.log(`Saved ${sample.id}: ${normalized.byteLength} bytes`);
}
