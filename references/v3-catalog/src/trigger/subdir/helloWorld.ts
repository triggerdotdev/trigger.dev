import { task } from "@trigger.dev/sdk/v3";

export const helloWorldSubdir = task({
  id: "hello-world-subdir-2",
  run: async (payload: { message: string }) => {
    return {
      hello: "worlds",
    };
  },
});
