import { logger, runs, task, tasks } from "@trigger.dev/sdk/v3";
import { fixedLengthTask } from "./prioritize-continuing.js";

type Payload = {
  tags: string | string[];
};

export const triggerRunsWithTags = task({
  id: "tags",
  run: async (payload: Payload, { ctx }) => {
    const { id } = await fixedLengthTask.trigger({ waitSeconds: 5 }, { tags: payload.tags });
  },
});
