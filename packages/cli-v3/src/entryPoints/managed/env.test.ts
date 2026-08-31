import { describe, expect, it } from "vitest";
import { RunnerEnv } from "./env.js";

function buildEnv(overrides: Record<string, string> = {}) {
  return new RunnerEnv({
    TRIGGER_CONTENT_HASH: "hash_1234",
    TRIGGER_PROJECT_ID: "project_1234",
    TRIGGER_PROJECT_REF: "proj_1234",
    TRIGGER_DEPLOYMENT_ID: "deployment_1234",
    TRIGGER_DEPLOYMENT_VERSION: "20260831.1",
    TRIGGER_ENV_ID: "env_1234",
    OTEL_EXPORTER_OTLP_ENDPOINT: "http://localhost:4318",
    TRIGGER_RUNNER_ID: "runner_1234",
    TRIGGER_POD_SCHEDULED_AT_MS: "1756600000000",
    TRIGGER_DEQUEUED_AT_MS: "1756600001000",
    TRIGGER_SUPERVISOR_API_PROTOCOL: "http",
    TRIGGER_SUPERVISOR_API_DOMAIN: "localhost",
    TRIGGER_SUPERVISOR_API_PORT: "8020",
    TRIGGER_WORKER_INSTANCE_NAME: "ip-10-0-1-23.ec2.internal",
    ...overrides,
  });
}

describe("RunnerEnv.gatherProcessEnv", () => {
  it("forwards the worker instance name into the run process", () => {
    // The task run worker is forked with this explicit env rather than the
    // container's process.env, so anything missing here never reaches the run
    // and telemetry exports with an empty host.
    const processEnv = buildEnv().gatherProcessEnv();

    expect(processEnv.TRIGGER_WORKER_INSTANCE_NAME).toBe("ip-10-0-1-23.ec2.internal");
  });

  it("carries the node name set by the Kubernetes downward API", () => {
    const processEnv = buildEnv({
      TRIGGER_WORKER_INSTANCE_NAME: "gke-prod-pool-a-9f21",
    }).gatherProcessEnv();

    expect(processEnv.TRIGGER_WORKER_INSTANCE_NAME).toBe("gke-prod-pool-a-9f21");
  });

  it("still forwards the OTLP endpoint under both names", () => {
    const processEnv = buildEnv().gatherProcessEnv();

    expect(processEnv.OTEL_EXPORTER_OTLP_ENDPOINT).toBe("http://localhost:4318");
    expect(processEnv.TRIGGER_OTEL_EXPORTER_OTLP_ENDPOINT).toBe("http://localhost:4318");
  });

  it("omits undefined values", () => {
    const processEnv = buildEnv().gatherProcessEnv();

    expect(processEnv).not.toHaveProperty("NODE_EXTRA_CA_CERTS");
    expect(Object.values(processEnv).every((value) => value !== undefined)).toBe(true);
  });
});
