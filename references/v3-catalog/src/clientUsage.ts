import { tasks, runs } from "@trigger.dev/sdk/v3";
import { createJsonHeroDoc } from "./trigger/simple";

async function main() {
  const anyHandle = await tasks.trigger("create-jsonhero-doc", {
    title: "Hello World",
    content: {
      message: "Hello, World!",
    },
  });

  const anyRun = await runs.retrieve(anyHandle);

  console.log(`Run ${anyHandle.id} completed with output:`, anyRun.output);

  const handle = await tasks.trigger<typeof createJsonHeroDoc>("create-jsonhero-doc", {
    title: "Hello World",
    content: {
      message: "Hello, World!",
    },
  });

  console.log(handle);

  const completedRun = await runs.poll(handle, { pollIntervalMs: 100 });

  console.log(`Run ${handle.id} completed with output:`, completedRun.output);

  const run = await tasks.triggerAndPoll<typeof createJsonHeroDoc>("create-jsonhero-doc", {
    title: "Hello World",
    content: {
      message: "Hello, World!",
    },
  });

  console.log(`Run ${run.id} completed with output: `, run.output);

  const batchHandle = await tasks.batchTrigger<typeof createJsonHeroDoc>("create-jsonhero-doc", [
    {
      payload: {
        title: "Hello World",
        content: {
          message: "Hello, World!",
        },
      },
    },
    {
      payload: {
        title: "Hello World 2",
        content: {
          message: "Hello, World 2!",
        },
      },
    },
  ]);

  const run2 = await runs.retrieve(batchHandle.runs[0]);
}

main().catch(console.error);
