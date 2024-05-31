import { configure, envvars, runs, schedules, ApiError } from "@trigger.dev/sdk/v3";
import dotenv from "dotenv";
import { createReadStream } from "node:fs";
import { firstScheduledTask } from "./trigger/scheduled";
import { simpleChildTask } from "./trigger/subtasks";
import { taskThatErrors } from "./trigger/retries";

dotenv.config();

async function doEnvVars() {
  configure({
    secretKey: process.env.TRIGGER_ACCESS_TOKEN,
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

  const response2 = await envvars.upload("yubjwjsfkxnylobaqvqz", "dev", {
    variables: createReadStream(".uploadable-env"),
    override: true,
  });

  console.log("response2", response2);

  const response3 = await envvars.upload("yubjwjsfkxnylobaqvqz", "prod", {
    variables: createReadStream(".uploadable-env"),
    override: true,
  });

  console.log("response3", response3);

  const response4 = await envvars.upload("yubjwjsfkxnylobaqvqz", "prod", {
    variables: await fetch(
      "https://gist.githubusercontent.com/ericallam/7a1001c6b03986a74d0f8aad4fd890aa/raw/fe2bc4da82f3b17178d47f58ec1458af47af5035/.env"
    ),
    override: true,
  });

  console.log("response4", response4);

  const response5 = await envvars.upload("yubjwjsfkxnylobaqvqz", "prod", {
    variables: new File(["IM_A_FILE=GREAT_FOR_YOU"], ".env"),
    override: true,
  });

  console.log("response5", response5);

  const response6 = await envvars.upload("yubjwjsfkxnylobaqvqz", "prod", {
    variables: Buffer.from("IN_BUFFER=TRUE"),
    override: true,
  });

  console.log("response6", response6);
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

  let page = await runs.list({
    limit: 100,
  });

  console.log(`run page #${++pageCount}`);

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

// doRuns().catch(console.error);
doListRuns().catch(console.error);
// doScheduleLists().catch(console.error);
// doSchedules().catch(console.error);
// doEnvVars().catch(console.error);
