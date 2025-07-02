import { metadata, task } from "@trigger.dev/sdk";

export const metadataTestTask = task({
  id: "metadata-tester",
  retry: {
    maxAttempts: 3,
    minTimeoutInMs: 500,
    maxTimeoutInMs: 1000,
    factor: 1.5,
  },
  run: async (payload: any, { ctx }) => {
    metadata.set("test-key", "test-value");
    metadata.append("test-keys", "test-value");
    metadata.increment("test-counter", 1);
  },
});
