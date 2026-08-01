import { describe, expect, it } from "vitest";
import type { WorkloadRunAttemptStartResponseBody } from "@trigger.dev/core/v3/workers";
import { startedAttemptLogProperties } from "./executionLogging.js";

const projectSecret = "project-env-var-secret-value";
const payloadSecret = "trigger-payload-secret-value";

function createStartResponse(): WorkloadRunAttemptStartResponseBody {
  return {
    snapshot: {
      id: "snapshot-1",
      friendlyId: "run_snapshot_1234",
      executionStatus: "EXECUTING",
      description: "Attempt started",
      createdAt: new Date(),
    },
    run: {
      id: "run-1",
      friendlyId: "run_1234",
      status: "EXECUTING",
      attemptNumber: 2,
    },
    execution: {
      run: {
        id: "run-1",
        payload: JSON.stringify({ apiKey: payloadSecret }),
        payloadType: "application/json",
        tags: [],
        isTest: false,
        isReplay: false,
        createdAt: new Date(),
        startedAt: new Date(),
      },
      attempt: { number: 2, startedAt: new Date() },
      task: { id: "test-task", filePath: "test.ts" },
      queue: { id: "queue-1", name: "test-queue" },
      environment: { id: "env-1", slug: "test", type: "PRODUCTION" },
      organization: { id: "org-1", slug: "test-org", name: "Test Org" },
      project: { id: "proj-1", ref: "proj_test", slug: "test", name: "Test" },
      machine: { name: "small-1x", cpu: 0.5, memory: 0.5, centsPerMs: 0 },
    },
    envVars: {
      DATABASE_URL: projectSecret,
      SOME_PROVIDER_API_KEY: projectSecret,
    },
  } as unknown as WorkloadRunAttemptStartResponseBody;
}

describe("startedAttemptLogProperties", () => {
  it("does not include environment variable values or the run payload", () => {
    const serialized = JSON.stringify(startedAttemptLogProperties(createStartResponse()));

    expect(serialized).not.toContain(projectSecret);
    expect(serialized).not.toContain(payloadSecret);
  });

  it("keeps environment variable names so operators can confirm what reached the run", () => {
    const properties = startedAttemptLogProperties(createStartResponse());

    expect(properties.envVarKeys).toEqual(["DATABASE_URL", "SOME_PROVIDER_API_KEY"]);
  });

  it("logs the identifiers needed to debug an attempt", () => {
    const properties = startedAttemptLogProperties(createStartResponse());

    expect(properties).toEqual({
      runId: "run-1",
      runFriendlyId: "run_1234",
      runStatus: "EXECUTING",
      attemptNumber: 2,
      snapshotId: "run_snapshot_1234",
      executionStatus: "EXECUTING",
      taskIdentifier: "test-task",
      queue: "test-queue",
      machinePreset: "small-1x",
      isTest: false,
      envVarKeys: ["DATABASE_URL", "SOME_PROVIDER_API_KEY"],
    });
  });

  it("handles a response with no environment variables", () => {
    const start = createStartResponse();
    // Older platform versions can omit envVars entirely.
    delete (start as Partial<WorkloadRunAttemptStartResponseBody>).envVars;

    expect(startedAttemptLogProperties(start).envVarKeys).toEqual([]);
  });
});
