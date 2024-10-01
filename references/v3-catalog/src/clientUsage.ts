import { runs, tasks } from "@trigger.dev/sdk/v3";
import type { runMetadataChildTask } from "./trigger/runMetadata.js";
import { setTimeout } from "timers/promises";

async function main() {
  for await (const run of runs.list({ taskIdentifier: "import-artwork", status: "QUEUED" })) {
    console.log("Cancelling run:", run.id);
    await runs.cancel(run.id);
    console.log("Cancelled run:", run.id);
  }

  // const anyHandle = await tasks.trigger<typeof runMetadataChildTask>("run-metadata-child-task", {});

  // const subscription = await runs.subscribe(anyHandle);

  // for await (const run of subscription) {
  //   console.log("Received run update:", run);
  // }
}

main().catch(console.error);
