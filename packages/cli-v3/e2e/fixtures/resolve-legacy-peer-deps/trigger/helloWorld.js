import { concat } from "lodash/array";
import { task } from "@trigger.dev/sdk/v3";

export const helloWorldTask = task({
  id: "hello-world",
  run: async (payload) => {
    console.log(concat(["Hello"], "World!").join(", "), payload);
  },
});
