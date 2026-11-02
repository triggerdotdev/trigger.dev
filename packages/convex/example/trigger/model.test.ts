import { afterEach, expect, test, vi } from "vitest";
import sharp from "sharp";

const { generateImage, image } = vi.hoisted(() => ({
  generateImage: vi.fn(),
  image: vi.fn(() => "test-image-model"),
}));
vi.mock("ai", () => ({ generateImage, createGateway: () => ({ image }) }));
import { editWithModel } from "./model";
import { MODEL_ID } from "../shared/catalog";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

test("one image request has no paid retries and returns a bounded PNG", async () => {
  vi.stubEnv("AI_GATEWAY_API_KEY", "test-only");
  const source = await sharp({
    create: { width: 1200, height: 800, channels: 3, background: "red" },
  })
    .png()
    .toBuffer();
  generateImage.mockResolvedValue({ images: [{}], image: { uint8Array: source } });
  const output = await editWithModel(source, "Make it blue");
  const decoded = await sharp(output).metadata();
  expect(decoded.width).toBeLessThanOrEqual(1024);
  expect(decoded.height).toBeLessThanOrEqual(1024);
  expect(decoded.format).toBe("png");
  expect(image).toHaveBeenCalledWith(MODEL_ID);
  expect(generateImage).toHaveBeenCalledTimes(1);
  expect(generateImage.mock.calls[0]![0]).toMatchObject({
    n: 1,
    maxImagesPerCall: 1,
    maxRetries: 0,
  });
});

test("provider failures do not leak request contents or cause another model call", async () => {
  vi.stubEnv("AI_GATEWAY_API_KEY", "test-only");
  generateImage.mockRejectedValue(new Error("private-prompt-and-image-bytes"));
  await expect(editWithModel(new Uint8Array([1]), "private prompt")).rejects.toThrow(
    "No automatic paid retry"
  );
  expect(generateImage).toHaveBeenCalledTimes(1);
});
