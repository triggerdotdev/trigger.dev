import { task } from "@trigger.dev/sdk/v3";

export const weirdFileName = task({
  id: "weird-file-name",
  run: async (payload: { url: string }) => {},
});
