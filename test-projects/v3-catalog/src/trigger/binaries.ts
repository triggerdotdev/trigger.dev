import { task } from "@trigger.dev/sdk/v3";
import ffmpeg from "fluent-ffmpeg";
import * as path from "node:path";
import { Readable } from "node:stream";
import type { ReadableStream } from "node:stream/web";

export const convertVideo = task({
  id: "convert-video",
  retry: {
    maxAttempts: 5,
    minTimeoutInMs: 1000,
    maxTimeoutInMs: 10000,
    factor: 2,
  },
  run: async ({ url }: { url: string }) => {
    const outputPath = path.join("/tmp", `output_${Date.now()}.mp4`);

    const response = await fetch(url);

    await new Promise((resolve, reject) => {
      ffmpeg(Readable.fromWeb(response.body as ReadableStream))
        .videoFilters("scale=iw/2:ih/2")
        .output(outputPath)
        .on("end", resolve)
        .on("error", reject)
        .run();
    });

    console.log(`Video converted to ${outputPath}`);

    return { success: true, outputPath };
  },
});
