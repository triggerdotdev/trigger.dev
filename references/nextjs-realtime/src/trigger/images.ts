import { idempotencyKeys, logger, metadata, schemaTask } from "@trigger.dev/sdk/v3";
import { FalResult, GridImage, UploadedFileData } from "@/utils/schemas";
import { z } from "zod";

import * as fal from "@fal-ai/serverless-client";

fal.config({
  credentials: process.env.FAL_KEY,
});

export const handleUpload = schemaTask({
  id: "handle-upload",
  schema: UploadedFileData,
  run: async (file, { ctx }) => {
    logger.info("Handling uploaded file", { file });

    const results = await runFalModel.batchTriggerAndWait([
      {
        payload: {
          model: "fal-ai/image-preprocessors/lineart",
          url: file.url,
          input: {},
        },
        options: {
          tags: ctx.run.tags,
        },
      },
      {
        payload: {
          model: "fal-ai/omni-zero",
          url: file.url,
          input: {
            prompt: "Turn the image into a cartoon",
            image_url: file.url,
            composition_image_url: file.url,
            style_image_url:
              "https://storage.googleapis.com/falserverless/model_tests/omni_zero/style.jpg",
            identity_image_url: file.url,
          },
        },
        options: { tags: ctx.run.tags },
      },
      {
        payload: {
          model: "fal-ai/imageutils/depth",
          url: file.url,
          input: {},
        },
        options: { tags: ctx.run.tags },
      },
    ]);

    return results;
  },
});

const RunFalModelInput = z.object({
  model: z.string(),
  url: z.string(),
  input: z.record(z.any()),
});

export const runFalModel = schemaTask({
  id: "run-fal-model",
  schema: RunFalModelInput,
  run: async (payload) => {
    return await internal_runFalModel(payload.model, payload.url, payload.input);
  },
});

async function internal_runFalModel(model: string, url: string, input: any) {
  const result = await fal.subscribe(model, {
    input: {
      image_url: url,
      ...input,
    },
    onQueueUpdate: (update) => {
      logger.info(model, { update });

      metadata.set("result", GridImage.parse(update));
    },
  });

  const parsedResult = FalResult.parse(result);

  metadata.set("$.result.image", parsedResult.image);

  return parsedResult.image;
}
