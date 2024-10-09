import { runs, tasks, auth } from "@trigger.dev/sdk/v3";
import type { runMetadataChildTask } from "./trigger/runMetadata.js";

async function main() {
  const anyHandle = await tasks.trigger<typeof runMetadataChildTask>("run-metadata-child-task", {});

  const jwt = await auth.generateJWT({ permissions: [anyHandle.id] });

  const subscription = await runs.subscribe(anyHandle);

  for await (const run of subscription) {
    console.log("Received run update:", run);
  }
}

main().catch(console.error);
