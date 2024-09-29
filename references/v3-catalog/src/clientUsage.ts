import { runs, tasks } from "@trigger.dev/sdk/v3";
import type { triggerRunsWithTags } from "./trigger/tags.js";

async function main() {
  const anyHandle = await tasks.trigger<typeof triggerRunsWithTags>("trigger-runs-with-tags", {
    tags: ["user:1234", "org:1234"],
  });

  await runs.subscribe(anyHandle, (anyRun) => {
    console.log(anyRun.payload.tags);
    console.log(anyRun.output?.tags);
  });
}

main().catch(console.error);
