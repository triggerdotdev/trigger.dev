import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  alertName,
  areaChips,
  capabilityChips,
  isComplete,
  prefillToAnswers,
  promptForStep,
  scopeChipsFor,
  skipsScope,
  withAutoAnswers,
  type FlowAnswers,
} from "~/components/dashboard-agent/alert-creation/flow-state";
import { FormSchema, buildScope } from "~/v3/services/alerts/alertDraft";
import { conditionSummary } from "./alertSummaries";
import { encodeErrorGroupScope, errorGroupLabel } from "~/utils/errorGroupScope";
import { SCOPE_VALUE_LABEL, allSteps, buildReviewFields } from "./wizardSteps";

const GROUP = {
  type: "errorGroup",
  taskIdentifier: "my-task",
  fingerprint: "abcdef0123456789",
} as const;

function flowFor(answers: FlowAnswers) {
  return { answers } as any;
}

function stepIds(answers: FlowAnswers) {
  return allSteps(flowFor(answers), [], "chat_1").map((s) => s.id);
}

describe("errors wizard", () => {
  it("offers the errors area and both capabilities", () => {
    expect(areaChips().map((c) => c.value)).toContain("errors");
    expect(capabilityChips("errors").map((c) => c.label)).toEqual([
      "A new error appearing",
      "This error occurring again",
    ]);
  });

  it("errors.occurred_again with a prefilled group shows the error answered, no condition", () => {
    const answers = withAutoAnswers({
      ...prefillToAnswers({ capability: "errors.occurred_again", scope: GROUP }),
      notifiers: ["chat"],
    });
    expect(answers.scope).toBe("errorGroup");
    expect(skipsScope(answers)).toBe(true);
    const ids = stepIds(answers);
    expect(ids).toEqual(["area", "what", "scope", "expiry", "notifiers", "name"]);
    const scope = allSteps(flowFor(answers), [], "chat_1").find((s) => s.id === "scope")!;
    expect(scope.selected).toEqual([encodeErrorGroupScope(GROUP)]);
    expect(scope.question).toBe("Which error should this alert watch?");
    expect(isComplete(answers)).toBe(true);

    const review = buildReviewFields(flowFor(answers), [])!;
    expect(review.conditionSummary).toBe("This error occurs again");
    expect(review.scopeLabel).toBe("my-task · abcdef01");
    expect(review.scopeValue).toBeUndefined();
    expect(review.behavior).toBe("recurring");
    expect(alertName(answers)).toContain("my-task · abcdef01");
  });

  // Mutation: dropping the custom input from the errors scope step fails this.
  it("errors.occurred_again without a group asks which error with an id input", () => {
    const answers = withAutoAnswers({ area: "errors", what: "errors.occurred_again" });
    const lookup = vi.fn();
    const scope = allSteps(flowFor(answers), [], undefined, undefined, {
      groups: [],
      lookup,
    }).find((s) => s.id === "scope")!;
    expect(scope.question).toBe("Which error should this alert watch?");
    expect(scope.hint).toBeUndefined();
    expect(scope.custom?.ariaLabel).toBe("Error id");
    scope.custom!.onSubmit(scope.custom!.parse(" error_abc ")!);
    expect(lookup).toHaveBeenCalledWith("error_abc");
    expect(isComplete(answers)).toBe(false);
  });

  // Mutation: restoring the hint constant or its text fails this.
  it("never shows the open-from-an-error hint", () => {
    const dir = new URL("../", import.meta.url);
    const sources = [
      "alerts/wizardSteps.ts",
      "alerts/CreationTranscript.tsx",
      "dashboard-agent/alert-creation/ManualCreationForm.tsx",
    ].map((file) => readFileSync(new URL(file, dir), "utf8"));
    for (const source of sources) {
      expect(source).not.toMatch(/OPEN_FROM_ERROR_HINT|Open this from an error/);
    }
  });

  it("scope prompts name the area", () => {
    expect(promptForStep("scope", { area: "queues" })).toBe(
      "Which queues should this alert cover?"
    );
    expect(promptForStep("scope", { area: "runs" })).toBe("Which tasks should this alert cover?");
    expect(promptForStep("scope", { area: "errors" })).toBe("Which error should this alert watch?");
  });

  it("errors.new offers all and task scopes, no condition step", () => {
    expect(scopeChipsFor("errors.new").map((c) => c.value)).toEqual(["all", "task"]);
    const ids = stepIds({ area: "errors", what: "errors.new" });
    expect(ids).toContain("scope");
    expect(ids).not.toContain("condition");
    expect(isComplete({ area: "errors", what: "errors.new", scope: "all" })).toBe(true);
  });

  it("labels the error group scope", () => {
    expect(errorGroupLabel(encodeErrorGroupScope(GROUP))).toBe("my-task · abcdef01");
    expect(SCOPE_VALUE_LABEL.errorGroup).toBe("Error group");
  });

  it("carries the error group through the create form", () => {
    const form = {
      capabilityKey: "errors.occurred_again",
      scopeType: "errorGroup",
      conditionKind: "occurrence",
      notifierChannelIds: ["ch_1"],
    };
    const ok = FormSchema.parse({ ...form, scopeValue: encodeErrorGroupScope(GROUP) });
    expect(buildScope(ok)).toEqual(GROUP);
    expect(FormSchema.safeParse({ ...form, scopeValue: "no-separator" }).success).toBe(false);
  });

  it("drops a malformed error group scope from the prefill", () => {
    const answers = prefillToAnswers({
      capability: "errors.occurred_again",
      scope: "errorGroup",
      scopeValue: "garbage",
    });
    expect(answers.scope).toBeUndefined();
    expect(answers.scopeValue).toBeUndefined();
    expect(skipsScope(withAutoAnswers(answers))).toBe(false);
  });

  it("summarises occurrence conditions with the capability title", () => {
    expect(conditionSummary({ kind: "occurrence" } as any, "count", "New error")).toBe("New error");
    expect(conditionSummary({ kind: "occurrence" } as any)).toBe("New occurrence");
  });
});
