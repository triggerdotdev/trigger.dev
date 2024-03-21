import { task } from "@trigger.dev/sdk/v3";
import slugify from "@sindresorhus/slugify";

export const loggingTask = task({
  id: "logging-task",
  run: async () => {
    console.log(`Hello world 9 ${slugify("foo bar")}`);

    return null;
  },
});
