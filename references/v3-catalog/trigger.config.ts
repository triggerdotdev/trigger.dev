import type { ProjectConfig } from "@trigger.dev/core/v3";

export { handleError } from "./src/handleError";

export const config: ProjectConfig = {
  project: "yubjwjsfkxnylobaqvqz",
  retries: {
    enabledInDev: true,
    default: {
      maxAttempts: 3,
      minTimeoutInMs: 1000,
      maxTimeoutInMs: 10000,
      factor: 2,
      randomize: true,
    },
  },
  additionalPackages: ["wrangler@3.35.0"],
};
