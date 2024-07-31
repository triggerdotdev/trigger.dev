import { task } from "@trigger.dev/sdk/v3";
import { MESSAGE } from "@compile-monorepo-packages/message";

export const helloWorldTask = task({
  id: "hello-world",
  run: async (payload) => {
    console.log(MESSAGE, payload);
  },
});
