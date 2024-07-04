import { task } from "@trigger.dev/sdk/v3";
import { MESSAGE } from "@dep-to-add-scope-parsing/dep-to-add";

export const helloWorldTask = task({
  id: "hello-world",
  run: async (payload) => {
    console.log(MESSAGE, payload);
  },
});
