import { tasks } from "@trigger.dev/sdk";

tasks.onStart(({ payload, ctx }) => {
  console.log(`Task ${ctx.task.id} started ${ctx.run.id}`);
});

tasks.onFailure(({ payload, error, ctx }) => {
  console.log(
    `Task ${ctx.task.id} failed ${ctx.run.id}: ${
      error instanceof Error ? error.message : String(error)
    }`
  );
});

tasks.catchError(({ payload, ctx, task, error, retry, retryAt, retryDelayInMs }) => {
  console.log("handling error", { error, retry, retryAt, retryDelayInMs });
});
