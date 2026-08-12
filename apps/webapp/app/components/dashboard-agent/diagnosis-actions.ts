import { isRunFriendlyId } from "./run-id";

export type DiagnosisActionInput = { kind: string; target: string; label: string };

export type PlannedDiagnosisAction = {
  kind: "view_run" | "docs";
  label: string;
  to: string;
};

/**
 * An action whose destination can't be resolved is dropped, never rendered as a
 * button that does nothing.
 */
export function planDiagnosisActions(
  actions: readonly DiagnosisActionInput[],
  resolve: {
    runPath: (runId: string) => string | null;
    docsUrl: (target: string) => string | null;
  }
): PlannedDiagnosisAction[] {
  const planned: PlannedDiagnosisAction[] = [];

  for (const action of actions) {
    if (action.kind === "view_run" && isRunFriendlyId(action.target)) {
      const to = resolve.runPath(action.target);
      if (to) planned.push({ kind: "view_run", label: action.label, to });
      continue;
    }
    if (action.kind === "docs") {
      const to = resolve.docsUrl(action.target);
      if (to) planned.push({ kind: "docs", label: action.label, to });
    }
  }

  return planned;
}
