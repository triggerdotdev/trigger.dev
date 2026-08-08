import { describe, expect, it } from "vitest";
import { planDiagnosisActions } from "./diagnosis-actions";

const RUN_PATH = "/orgs/acme/projects/api/env/prod/runs/run_abc123";

const resolve = {
  runPath: () => RUN_PATH,
  docsUrl: (target: string) => (target.startsWith("https://") ? target : null),
};

// Org/project/env context is missing, so no run URL can be built.
const withoutContext = { ...resolve, runPath: () => null };

const viewRun = { kind: "view_run", target: "run_abc123", label: "View run" };
const docs = { kind: "docs", target: "https://trigger.dev/docs/errors", label: "Read the docs" };

describe("planDiagnosisActions", () => {
  it("keeps a run action that resolves to a path", () => {
    expect(planDiagnosisActions([viewRun], resolve)).toEqual([
      { kind: "view_run", label: "View run", to: RUN_PATH },
    ]);
  });

  it("drops a run action when the path can't be resolved", () => {
    expect(planDiagnosisActions([viewRun], withoutContext)).toEqual([]);
  });

  it("drops only the unresolvable action, keeping the rest", () => {
    expect(planDiagnosisActions([viewRun, docs], withoutContext)).toEqual([
      { kind: "docs", label: "Read the docs", to: docs.target },
    ]);
  });

  it("drops a run action whose target is not a run id", () => {
    expect(planDiagnosisActions([{ ...viewRun, target: "the payments task" }], resolve)).toEqual(
      []
    );
  });

  it("drops a docs action with an unsafe target", () => {
    expect(planDiagnosisActions([{ ...docs, target: "javascript:alert(1)" }], resolve)).toEqual([]);
  });

  it("drops an action kind it does not know", () => {
    expect(planDiagnosisActions([{ ...viewRun, kind: "replay_run" }], resolve)).toEqual([]);
  });
});
