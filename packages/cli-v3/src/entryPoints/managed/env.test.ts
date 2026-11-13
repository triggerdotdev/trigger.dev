import { describe, it, expect } from "vitest";
import { RunnerEnv } from "./env.js";

const requiredEnv = {
  TRIGGER_CONTENT_HASH: "hash",
  TRIGGER_PROJECT_ID: "proj_1",
  TRIGGER_PROJECT_REF: "proj_ref",
  TRIGGER_DEPLOYMENT_ID: "deploy_1",
  TRIGGER_DEPLOYMENT_VERSION: "20261020.1",
  TRIGGER_ENV_ID: "env_1",
  OTEL_EXPORTER_OTLP_ENDPOINT: "https://example.com/otel",
  TRIGGER_RUNNER_ID: "runner_1",
  TRIGGER_POD_SCHEDULED_AT_MS: "1",
  TRIGGER_DEQUEUED_AT_MS: "1",
  TRIGGER_SUPERVISOR_API_PROTOCOL: "http",
  TRIGGER_SUPERVISOR_API_DOMAIN: "localhost",
  TRIGGER_SUPERVISOR_API_PORT: "8000",
  TRIGGER_WORKER_INSTANCE_NAME: "worker",
};

describe("RunnerEnv.gatherProcessEnv", () => {
  it.each(["", "/app/certs/corp-root.pem"])(
    "leaves NODE_EXTRA_CA_CERTS=%j to the task run env",
    (value) => {
      const env = new RunnerEnv({ ...requiredEnv, NODE_EXTRA_CA_CERTS: value });

      expect(env.gatherProcessEnv()).not.toHaveProperty("NODE_EXTRA_CA_CERTS");
    }
  );
});

describe("RunnerEnv supervisor wait", () => {
  // Catches: RunnerEnv dropping the supervisor wait variables as undeclared keys.
  it("reads how long the runner was held for its supervisor", () => {
    const env = new RunnerEnv({
      ...requiredEnv,
      TRIGGER_SUPERVISOR_WAIT_STARTED_AT_MS: "1762860000123",
      TRIGGER_SUPERVISOR_WAIT_MS: "328",
    });

    expect(env.TRIGGER_SUPERVISOR_WAIT_STARTED_AT_MS).toEqual(new Date(1762860000123));
    expect(env.TRIGGER_SUPERVISOR_WAIT_MS).toBe(328);
  });
});
