import { runs } from "@trigger.dev/sdk/v3";
import { simpleChildTask } from "./trigger/subtasks";
import dotenv from "dotenv";

dotenv.config();

export async function run() {
  const run = await simpleChildTask.trigger({ payload: { message: "Hello, World!" } });
  const canceled = await runs.cancel(run.id);
  console.log("canceled run", canceled);

  const replayed = await runs.replay(run.id);
  console.log("replayed run", replayed);
}

run();
