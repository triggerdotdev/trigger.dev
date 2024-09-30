import { runs, tasks } from "@trigger.dev/sdk/v3";
import type { triggerRunsWithTags } from "./trigger/tags.js";

async function main() {
  const anyHandle = await tasks.trigger<typeof triggerRunsWithTags>("trigger-runs-with-tags", {
    tags: ["user:1234", "org:1234"],
  });

  const subscription = await runs.subscribe(anyHandle);

  for await (const run of subscription) {
    console.log("Received run update:", run);
  }
}

main().catch(console.error);
