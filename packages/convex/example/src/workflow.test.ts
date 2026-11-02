import { expect, test } from "vitest";
import type { Job } from "../shared/types";
import { progressFromRun, workflowPhase } from "./workflow";

const job: Job = {
  id: "job",
  sample: "forest",
  prompt: "edit",
  preset: "balanced",
  createdAt: 0,
  expiresAt: 1,
  status: "EXECUTING",
  syncStatus: "pending",
  progress: 25,
  stage: "Editing",
  runId: "run",
  error: null,
  results: [],
};

test("Realtime completion does not mark the image ready before Convex publishes results", () => {
  expect(progressFromRun(job, { id: "run", metadata: { progress: 100 } })).toBe(95);
  expect(workflowPhase(95, false)).toBe("finish");
});

test("ignores workflow metadata from a different run", () => {
  expect(progressFromRun(job, { id: "other-run", metadata: { progress: 90 } })).toBe(25);
});

test("ignores non-finite progress metadata", () => {
  expect(
    progressFromRun(job, { id: "run", metadata: { progress: Number.POSITIVE_INFINITY } })
  ).toBe(25);
});

test("counts ready flags idempotently", () => {
  const run = {
    id: "run",
    metadata: { phase: "finish", heroReady: true, cardReady: true, squareReady: false },
  };
  expect(progressFromRun(job, run)).toBe(85);
  expect(progressFromRun(job, run)).toBe(85);
});
