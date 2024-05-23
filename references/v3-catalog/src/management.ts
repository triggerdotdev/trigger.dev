import { tracer } from "./tracer";
import { APIError, configure, runs, schedules, envvars } from "@trigger.dev/sdk/v3";
import { simpleChildTask } from "./trigger/subtasks";
import dotenv from "dotenv";
import { firstScheduledTask } from "./trigger/scheduled";
import { createReadStream } from "node:fs";

dotenv.config();

async function uploadEnvVars() {
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

export async function run() {
  await tracer.startActiveSpan("run", async (span) => {
    try {
      const run = await simpleChildTask.trigger({ message: "Hello, World!" });

      const retrievedRun = await runs.retrieve(run.id);
      console.log("retrieved run", retrievedRun);

      const canceled = await runs.cancel(run.id);
      console.log("canceled run", canceled);

      const replayed = await runs.replay(run.id);
      console.log("replayed run", replayed);

      const run2 = await simpleChildTask.trigger(
        { message: "Hello, World!" },
        {
          idempotencyKey: "mmvlgwcidiklyeygen4",
        }
      );

      const run3 = await simpleChildTask.trigger(
        { message: "Hello, World again!" },
        {
          idempotencyKey: "mmvlgwcidiklyeygen4",
        }
      );

      console.log("run2", run2);
      console.log("run3", run3);

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
    } catch (error) {
      span.recordException(error as Error);

      if (error instanceof APIError) {
        console.error("APIError", error);
      } else {
        console.error("Unknown error", error);
      }
    } finally {
      span.end();
    }
  });
}

// run();
uploadEnvVars().catch(console.error);
