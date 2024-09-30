import { runs, tasks } from "@trigger.dev/sdk/v3";
import type { runMetadataChildTask } from "./trigger/runMetadata.js";

async function main() {
  const anyHandle = await tasks.trigger<typeof runMetadataChildTask>("run-metadata-child-task", {});

  const subscription = await runs.subscribe(anyHandle);

  for await (const run of subscription) {
    console.log("Received run update:", run);
  }
}

main().catch(console.error);
