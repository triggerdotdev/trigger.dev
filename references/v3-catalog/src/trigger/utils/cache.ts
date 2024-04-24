import { InMemoryCache, createCache } from "@trigger.dev/sdk/v3";

export const cache = createCache(new InMemoryCache());

export const fakeTask = {
  id: "this-task-doesnt-exist",
};
