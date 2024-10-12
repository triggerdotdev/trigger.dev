import { logger, metadata, schemaTask } from "@trigger.dev/sdk/v3";
import { FalResult, GridImage, UploadedFileData } from "@/utils/schemas";

import * as fal from "@fal-ai/serverless-client";

fal.config({
  credentials: process.env.FAL_KEY,
});

export const handleUpload = schemaTask({
  id: "handle-upload",
  schema: UploadedFileData,
  run: async (file, { ctx }) => {
    logger.info("Handling uploaded file", { file });

    await Promise.all([
      runFalModel("fal-ai/image-preprocessors/canny", file.url, {
        low_threshold: 100,
        high_threshold: 200,
      }),
      runFalModel("fal-ai/aura-sr", file.url, {}),
    ]);
  },
});

async function runFalModel(model: string, url: string, input: any) {
  const result = await fal.subscribe(model, {
    input: {
      image_url: url,
      ...input,
    },
    onQueueUpdate: (update) => {
      logger.info(model, { update });

      metadata.set(model, GridImage.parse(update));
    },
  });

  const parsedResult = FalResult.parse(result);

  metadata.set(`$.${model}.image`, parsedResult.image);

  return parsedResult.image;
}
