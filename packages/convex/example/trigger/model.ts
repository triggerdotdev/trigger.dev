import { createGateway, generateImage } from "ai";
import sharp from "sharp";
import { MODEL_ID } from "../shared/catalog";

export async function editWithModel(input: Uint8Array, prompt: string) {
  const apiKey = process.env.AI_GATEWAY_API_KEY;
  if (!apiKey) throw new Error("AI_GATEWAY_API_KEY is not configured on Trigger.");
  try {
    const gateway = createGateway({ apiKey });
    const result = await generateImage({
      model: gateway.image(MODEL_ID),
      prompt: {
        text: `Edit this photograph according to the following instruction. Return one edited image.\n\n${prompt}`,
        images: [input],
      },
      n: 1,
      maxImagesPerCall: 1,
      maxRetries: 0,
      abortSignal: AbortSignal.timeout(90_000),
    });
    if (result.images.length !== 1) throw new Error("Expected one image");
    return await sharp(result.image.uint8Array, { limitInputPixels: 12_000_000 })
      .rotate()
      .resize({ width: 1024, height: 1024, fit: "inside", withoutEnlargement: true })
      .png()
      .toBuffer();
  } catch {
    // Provider errors can contain prompts and image bytes. Keep them out of task errors.
    throw new Error("The image model request failed. No automatic paid retry was made.");
  }
}
