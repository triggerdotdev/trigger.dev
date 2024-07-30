import { tasks, runs, TaskOutput, TaskPayload, TaskIdentifier } from "@trigger.dev/sdk/v3";
import { createJsonHeroDoc } from "./trigger/simple";
import { TaskOutputHandle } from "@trigger.dev/sdk/v3/shared";

type createJsonHeroDocPayload = TaskPayload<typeof createJsonHeroDoc>; // retrieves the payload type of the task
type createJsonHeroDocOutput = TaskOutput<typeof createJsonHeroDoc>; // retrieves the output type of the task
type createJsonHeroDocIdentifier = TaskIdentifier<typeof createJsonHeroDoc>; // retrieves the identifier of the task
type createJsonHeroDocHandle = TaskOutputHandle<typeof createJsonHeroDoc>; // retrieves the handle of the task

async function main() {
  const anyHandle = await tasks.trigger(
    "create-jsonhero-doc",
    {
      title: "Hello World",
      content: {
        message: "Hello, World!",
      },
    },
    {
      delay: "1m",
      ttl: "1m",
    }
  );

  const anyRun = await runs.retrieve(anyHandle);

  console.log(`Run ${anyHandle.id} status: ${anyRun.status}, ttl: ${anyRun.ttl}`, anyRun.output);

  const typedRun = await runs.retrieve<typeof createJsonHeroDoc>(anyHandle.id);

  console.log(`Run ${anyHandle.id} status: ${typedRun.status}`, typedRun.output);

  await new Promise((resolve) => setTimeout(resolve, 121000)); // wait for 2 minutes

  const expiredRun = await runs.retrieve(anyRun.id);

  console.log(
    `Run ${anyHandle.id} status: ${expiredRun.status}, expired at: ${expiredRun.expiredAt}`,
    expiredRun.output
  );

  const handle = await tasks.trigger<typeof createJsonHeroDoc>("create-jsonhero-doc", {
    title: "Hello World",
    content: {
      message: "Hello, World!",
    },
  });

  console.log(handle);

  const typedRetrieveRun = await runs.retrieve(handle);

  console.log(`Run ${handle.id} status: ${typedRetrieveRun.status}`, typedRetrieveRun.output);

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

  const firstRunHandle = batchHandle.runs[0];

  const run2 = await runs.retrieve(firstRunHandle);

  console.log(`Run ${run2.id} completed with output: `, run2.output);
}

main().catch(console.error);
