import type { ProjectConfig } from "@trigger.dev/core/v3";

export const config: ProjectConfig = {
  project: "${projectRef}",
  retries: {
    enabledInDev: false,
    default: {
      maxAttempts: 3,
      minTimeoutInMs: 1000,
      maxTimeoutInMs: 10000,
      factor: 2,
      randomize: true,
    },
  },
};
