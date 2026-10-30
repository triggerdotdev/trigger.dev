import { createImageSet } from "../trigger/processor.ts";

const output = await createImageSet("forest", "balanced", async (stage, progress) => {
  console.log(`${progress}% ${stage}`);
});
console.log(
  JSON.stringify(
    {
      inputBytes: output.inputBytes,
      processingMs: output.processingMs,
      variants: output.variants.map(({ data, ...variant }) => variant),
    },
    null,
    2
  )
);
