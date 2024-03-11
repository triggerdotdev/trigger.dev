/** @type {import('@trigger.dev/sdk/v3').Config} */

export default {
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
};
