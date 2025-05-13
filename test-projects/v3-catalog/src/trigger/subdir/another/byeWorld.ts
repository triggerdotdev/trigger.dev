import { task } from "@trigger.dev/sdk/v3";

export const byeWorldSubdir = task({
  id: "bye-world-subdir-2",
  run: async (payload: { message: string }) => {
    return {
      bye: "worlds",
    };
  },
});
