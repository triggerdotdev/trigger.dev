import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// Asserts every scalar column of the run-subgraph models in the control-plane
// schema also exists in the dedicated schema (so the dedicated DB can hold the
// same row shape), and that the dedicated schema contains NO reference to a
// control-plane model name.
const CONTROL_PLANE_MODELS = [
  "Organization",
  "OrgMember",
  "Project",
  "RuntimeEnvironment",
  "User",
  "TaskSchedule",
  "BackgroundWorker",
  "BackgroundWorkerTask",
  "WorkerDeployment",
  "TaskQueue",
];

function readSchema(rel: string) {
  return readFileSync(resolve(__dirname, rel), "utf8");
}

// Prisma comments (`///` docs and `//` lines) may legitimately mention
// control-plane model names in prose, which would false-match the drift
// regexes below. Strip them so parity assertions only see real schema syntax.
function stripComments(schema: string) {
  return schema.replace(/\/\/.*$/gm, "");
}

describe("dedicated run-ops schema parity", () => {
  it("references no control-plane model as a relation target", () => {
    const dedicated = stripComments(readSchema("./schema.prisma"));
    for (const model of CONTROL_PLANE_MODELS) {
      // A relation target appears as `  fieldName  Model @relation(...)`. A bare
      // scalar column like `projectId String` is fine; the model TYPE must be absent.
      const relationTarget = new RegExp(
        `@relation[^\\n]*\\b${model}\\b|\\b${model}\\b[^\\n]*@relation`
      );
      expect(dedicated).not.toMatch(relationTarget);
      expect(dedicated).not.toMatch(new RegExp(`\\s${model}(\\?|\\[\\])?\\s`));
    }
  });

  it("includes all 14 run-subgraph models", () => {
    const dedicated = readSchema("./schema.prisma");
    for (const m of [
      "TaskRun",
      "TaskRunAttempt",
      "TaskRunExecutionSnapshot",
      "TaskRunWaitpoint",
      "TaskRunCheckpoint",
      "CheckpointRestoreEvent",
      "TaskRunTag",
      "Waitpoint",
      "WaitpointTag",
      "BatchTaskRun",
      "TaskRunDependency",
      "BatchTaskRunItem",
      "BatchTaskRunError",
      "Checkpoint",
    ]) {
      expect(dedicated).toMatch(new RegExp(`model ${m} \\{`));
    }
  });

  it("keeps the group-(A) waitpoint-block references FK-FREE (scalar columns / explicit FK-free join models)", () => {
    const dedicated = stripComments(readSchema("./schema.prisma"));
    // TaskRunWaitpoint must NOT carry a `@relation` to Waitpoint/TaskRun/BatchTaskRun.
    const trw = dedicated.match(/model TaskRunWaitpoint \{[\s\S]*?\n\}/)![0];
    expect(trw).not.toMatch(/@relation/);
    expect(trw).toMatch(/waitpointId\s+String/);
    expect(trw).toMatch(/taskRunId\s+String/);
    // The two implicit M2M sets are replaced by explicit FK-free join models.
    expect(dedicated).toMatch(/model WaitpointRunConnection \{/);
    expect(dedicated).toMatch(/model CompletedWaitpoint \{/);
    const wrc = dedicated.match(/model WaitpointRunConnection \{[\s\S]*?\n\}/)![0];
    expect(wrc).not.toMatch(/@relation/);
    // Waitpoint completion back-refs are scalar, not relations.
    const wp = dedicated.match(/model Waitpoint \{[\s\S]*?\n\}/)![0];
    expect(wp).not.toMatch(/completedByTaskRun\s+TaskRun\s*\?\s*@relation/);
  });

  it("keeps the group-(B) co-resident references as real FKs (e.g. TaskRunAttempt.taskRun)", () => {
    const dedicated = stripComments(readSchema("./schema.prisma"));
    const attempt = dedicated.match(/model TaskRunAttempt \{[\s\S]*?\n\}/)![0];
    // The attempt->run relation stays a real FK (always co-resident).
    expect(attempt).toMatch(/taskRun\s+TaskRun\s+@relation/);
  });
});
