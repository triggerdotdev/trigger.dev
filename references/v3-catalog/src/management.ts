import { configure, envvars, runs, schedules, batch, auth } from "@trigger.dev/sdk/v3";
import dotenv from "dotenv";
import { unfriendlyIdTask } from "./trigger/other.js";
import { spamRateLimiter, taskThatErrors } from "./trigger/retries.js";
import { firstScheduledTask } from "./trigger/scheduled.js";
import { simpleChildTask } from "./trigger/subtasks.js";

dotenv.config();

async function doSpamRateLimiter() {
  // Trigger 10 runs
  await spamRateLimiter.batchTrigger(
    Array.from({ length: 10 }, (_, i) => ({ payload: { runId: "run_pxxs52j3geik6cj6j8piq" } }))
  );
}

// doSpamRateLimiter().catch(console.error);

async function doEnvVars() {
  configure({
    secretKey: process.env.TRIGGER_ACCESS_TOKEN,
    requestOptions: {
      retry: {
        maxAttempts: 1,
      },
    },
  });

  const response1 = await envvars.upload("yubjwjsfkxnylobaqvqz", "dev", {
    variables: {
      MY_ENV_VAR: "MY_ENV_VAR_VALUE",
    },
    override: true,
  });

  console.log("response1", response1);

  const envVars = await envvars.list("yubjwjsfkxnylobaqvqz", "dev");

  console.log("envVars", envVars);

  const createResponse = await envvars.create("yubjwjsfkxnylobaqvqz", "dev", {
    name: "MY_ENV_VAR_CREATE",
    value: "MY_ENV_VAR_VALUE_CREATE",
  });

  console.log("createResponse", createResponse);

  const retrieveResponse = await envvars.retrieve(
    "yubjwjsfkxnylobaqvqz",
    "dev",
    "MY_ENV_VAR_CREATE"
  );

  console.log("retrieveResponse", retrieveResponse);

  const updateResponse = await envvars.update("yubjwjsfkxnylobaqvqz", "dev", "MY_ENV_VAR_CREATE", {
    value: "MY_ENV_VAR_VALUE_CREATE_UPDATED",
  });

  console.log("updateResponse", updateResponse);

  const deleteResponse = await envvars.del("yubjwjsfkxnylobaqvqz", "dev", "MY_ENV_VAR_CREATE");

  console.log("deleteResponse", deleteResponse);
}

async function doRuns() {
  const run = await simpleChildTask.trigger({ message: "Hello, World!" });

  const retrievedRun = await runs.retrieve(run.id);
  console.log("retrieved run", retrievedRun);

  const completedRun = await waitForRunToComplete(run.id);
  console.log("completed run", completedRun);

  const failingRun = await taskThatErrors.trigger({ message: "Hello, World!" });
  const failedRun = await waitForRunToComplete(failingRun.id);

  console.log("failed run", failedRun);

  const replayableRun = await runs.replay(failedRun.id);
  const replayedRun = await waitForRunToExecute(replayableRun.id);

  console.log("replayed run", replayedRun);

  const canceledRun = await runs.cancel(replayedRun.id);
  const canceledRunResult = await waitForRunToComplete(canceledRun.id);

  console.log("canceled run", canceledRunResult);
}

async function doListRuns() {
  let pageCount = 0;

  let page = await runs.list(
    {
      limit: 100,
    },
    {
      retry: {
        maxAttempts: 1,
      },
    }
  );

  console.log(`run page #${++pageCount}, with ${page.data.length} runs`);

  // Convenience methods are provided for manually paginating:
  while (page.hasNextPage()) {
    page = await page.getNextPage();
    console.log(`run page #${++pageCount}`);
  }

  while (page.hasPreviousPage()) {
    page = await page.getPreviousPage();
    console.log(`run page #${--pageCount}`);
  }

  for await (const run of runs.list({
    status: ["COMPLETED"],
    period: "1y",
  })) {
    console.log(run);
  }

  let withResponse = await runs
    .list({
      limit: 100,
    })
    .withResponse();

  console.log(
    "withResponse",
    withResponse.response.status,
    withResponse.response.headers,
    withResponse.data.data.length
  );

  configure({
    secretKey: process.env.TRIGGER_ACCESS_TOKEN,
  });

  for await (const run of runs.list("yubjwjsfkxnylobaqvqz", {
    status: ["COMPLETED"],
    period: "1y",
    env: ["dev", "staging", "prod"],
  })) {
    console.log(run.env.name, run.isTest, run.id, run.status, run.createdAt);
  }
}

async function waitForRunToComplete(runId: string) {
  let run = await runs.retrieve(runId);

  while (!run.isCompleted) {
    console.log("run is not completed, waiting...", run);
    await new Promise((resolve) => setTimeout(resolve, 2000));
    run = await runs.retrieve(runId);
  }

  console.log("run is completed", run);

  return run;
}

async function waitForRunToExecute(runId: string) {
  let run = await runs.retrieve(runId);

  while (!run.isExecuting) {
    console.log("run is not executing, waiting...", run);
    await new Promise((resolve) => setTimeout(resolve, 2000));
    run = await runs.retrieve(runId);
  }

  console.log("run is executing", run);

  return run;
}

async function doSchedules() {
  const allSchedules = await schedules.list();

  console.log("all schedules", allSchedules);

  // Create a schedule
  const createdSchedule = await schedules.create({
    task: firstScheduledTask.id,
    cron: "0 0 * * *",
    externalId: "ext_1234444",
    deduplicationKey: "dedup_1234444",
  });

  console.log("created schedule", createdSchedule);

  const retrievedSchedule = await schedules.retrieve(createdSchedule.id);

  console.log("retrieved schedule", retrievedSchedule);

  const updatedSchedule = await schedules.update(createdSchedule.id, {
    task: firstScheduledTask.id,
    cron: "0 0 1 * *",
    externalId: "ext_1234444",
  });

  console.log("updated schedule", updatedSchedule);

  const deactivatedSchedule = await schedules.deactivate(createdSchedule.id);

  console.log("deactivated schedule", deactivatedSchedule);

  const activatedSchedule = await schedules.activate(createdSchedule.id);

  console.log("activated schedule", activatedSchedule);

  const deletedSchedule = await schedules.del(createdSchedule.id);

  console.log("deleted schedule", deletedSchedule);
}

async function doScheduleLists() {
  let pageCount = 0;

  let page = await schedules.list({
    perPage: 2,
  });

  console.log(`schedule page #${++pageCount}`);

  // Convenience methods are provided for manually paginating:
  while (page.hasNextPage()) {
    page = await page.getNextPage();
    console.log(`schedule page #${++pageCount}`);
  }

  while (page.hasPreviousPage()) {
    page = await page.getPreviousPage();
    console.log(`schedule page #${--pageCount}`);
  }

  for await (const schedule of schedules.list({
    perPage: 2,
  })) {
    console.log(schedule.id, schedule.task, schedule.generator);
  }
}

async function doTriggerUnfriendlyTaskId() {
  const run = await unfriendlyIdTask.trigger();

  console.log("unfriendly id task run", run);

  const completedRun = await waitForRunToComplete(run.id);

  console.log("completed run", completedRun);
}

async function doBatchTrigger() {
  const response = await batch.triggerByTask([
    { task: simpleChildTask, payload: { message: "Hello, World!" } },
  ]);

  console.log("batch trigger response", response);

  const $batch = await batch.retrieve(response.batchId);

  console.log("batch", $batch);

  const $runs = await runs.list({ batch: response.batchId });

  console.log("batch runs", $runs.data);
}

async function doRescheduleRun() {
  const run = await simpleChildTask.trigger({ message: "Hello, World!" }, { delay: "1h" });

  console.log("run", run);

  const reschedule = await runs.reschedule(run.id, {
    delay: "1s",
  });

  console.log("reschedule", reschedule);

  const rescheduledRun = await waitForRunToComplete(reschedule.id);

  console.log("rescheduled run", rescheduledRun);
}

async function doOneTimeUseTrigger() {
  console.log("Testing with one-time use token");

  try {
    await auth.withTriggerPublicToken(simpleChildTask.id, {}, async () => {
      const run1 = await simpleChildTask.trigger({ message: "Hello, World!" });

      console.log("run1", run1);

      const run2 = await simpleChildTask.trigger({ message: "Hello, World!" });

      console.log("run2", run2);
    });
  } catch (error) {
    console.error(error);
  }

  console.log("Testing with deprecated public token");

  try {
    await auth.withPublicToken(
      {
        scopes: {
          write: {
            tasks: simpleChildTask.id,
          },
        },
      },
      async () => {
        const run1 = await simpleChildTask.trigger({ message: "Hello, World!" });
      }
    );
  } catch (error) {
    console.error(error);
  }

  console.log("Testing with trigger public token");

  try {
    await auth.withPublicToken(
      {
        scopes: {
          trigger: {
            tasks: simpleChildTask.id,
          },
        },
      },
      async () => {
        const run1 = await simpleChildTask.trigger({ message: "Hello, World!" });

        console.log("run1", run1);

        const run2 = await simpleChildTask.trigger({ message: "Hello, World!" });

        console.log("run2", run2);
      }
    );
  } catch (error) {
    console.error(error);
  }

  console.log("Testing with a one-time use token for the wrong task");

  try {
    await auth.withTriggerPublicToken("wrong-task-id", {}, async () => {
      const run1 = await simpleChildTask.trigger({ message: "Hello, World!" });

      console.log("run1", run1);
    });
  } catch (error) {
    console.error(error);
  }

  console.log("Testing with a public token for the wrong task");

  try {
    await auth.withPublicToken(
      {
        scopes: {
          write: {
            tasks: "wrong-task-id",
          },
        },
      },
      async () => {
        const run1 = await simpleChildTask.trigger({ message: "Hello, World!" });

        console.log("run1", run1);
      }
    );
  } catch (error) {
    console.error(error);
  }

  console.log("Testing batch trigger with one-time use token");

  try {
    await auth.withBatchTriggerPublicToken(simpleChildTask.id, {}, async () => {
      const batch1 = await batch.triggerByTask([
        { task: simpleChildTask, payload: { message: "Hello, World!" } },
      ]);

      console.log("batch1", batch1);

      const batch2 = await batch.triggerByTask([
        { task: simpleChildTask, payload: { message: "Hello, World!" } },
      ]);
    });
  } catch (error) {
    console.error(error);
  }

  console.log("Testing batch trigger with a trigger token");

  try {
    await auth.withTriggerPublicToken(simpleChildTask.id, {}, async () => {
      const batch1 = await batch.triggerByTask([
        { task: simpleChildTask, payload: { message: "Hello, World!" } },
      ]);

      console.log("batch1", batch1);
    });
  } catch (error) {
    console.error(error);
  }
}

// doRuns().catch(console.error);
// doListRuns().catch(console.error);
// doScheduleLists().catch(console.error);
// doBatchTrigger().catch(console.error);
// doEnvVars().catch(console.error);
// doTriggerUnfriendlyTaskId().catch(console.error);
// doRescheduleRun().catch(console.error);
doOneTimeUseTrigger().catch(console.error);
