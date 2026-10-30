import { expect, test } from "vitest";
import sharp from "sharp";
import { createImageSet } from "./processor";
import { VARIANTS } from "../shared/catalog";

test("creates real cropped AVIF files at the requested dimensions", async () => {
  const output = await createImageSet("coast", "balanced");
  expect(output.variants).toHaveLength(3);
  for (const [index, image] of output.variants.entries()) {
    const decoded = await sharp(image.data).metadata();
    expect(decoded.width).toBe(VARIANTS[index]!.width);
    expect(decoded.height).toBe(VARIANTS[index]!.height);
    expect(decoded.format).toBe("heif");
    expect(image.bytes).toBe(image.data.byteLength);
    expect(image.bytes).toBeGreaterThan(0);
  }
  expect(output.processingMs).toBeGreaterThan(0);
}, 60_000);
