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

  console.log(`Run ${anyHandle.id} status: ${anyRun.status}, ttl: ${anyRun.ttl}`);

  await new Promise((resolve) => setTimeout(resolve, 121000)); // wait for 2 minutes

  const expiredRun = await runs.retrieve(anyRun.id);

  console.log(
    `Run ${anyHandle.id} status: ${expiredRun.status}, expired at: ${expiredRun.expiredAt}`
  );

  // const handle = await tasks.trigger<typeof createJsonHeroDoc>("create-jsonhero-doc", {
  //   title: "Hello World",
  //   content: {
  //     message: "Hello, World!",
  //   },
  // });

  // console.log(handle);

  // const completedRun = await runs.poll(handle, { pollIntervalMs: 100 });

  // console.log(`Run ${handle.id} completed with output:`, completedRun.output);

  // const run = await tasks.triggerAndPoll<typeof createJsonHeroDoc>("create-jsonhero-doc", {
  //   title: "Hello World",
  //   content: {
  //     message: "Hello, World!",
  //   },
  // });

  // console.log(`Run ${run.id} completed with output: `, run.output);

  // const batchHandle = await tasks.batchTrigger<typeof createJsonHeroDoc>("create-jsonhero-doc", [
  //   {
  //     payload: {
  //       title: "Hello World",
  //       content: {
  //         message: "Hello, World!",
  //       },
  //     },
  //   },
  //   {
  //     payload: {
  //       title: "Hello World 2",
  //       content: {
  //         message: "Hello, World 2!",
  //       },
  //     },
  //   },
  // ]);

  // const run2 = await runs.retrieve(batchHandle.runs[0]);
}

main().catch(console.error);
