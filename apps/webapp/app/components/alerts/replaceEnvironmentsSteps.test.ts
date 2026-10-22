import { describe, expect, it } from "vitest";
import type { CreationFlowState } from "~/components/dashboard-agent/alert-creation/CreationFlow";
import {
  alertName,
  draftMissing,
  prefillToAnswers,
  replacePrefill,
  type FlowAnswers,
  type ReplaceEnvironment,
} from "~/components/dashboard-agent/alert-creation/flow-state";
import { allSteps, applyStepSelection, confirmStep, PREVIEW_GROUP } from "./wizardSteps";

const noop = () => {};
const DESCRIPTION = "Replace creates one alert per environment. Pick the environments to watch.";

const env = (id: string, type: string, branchName: string | null = null): ReplaceEnvironment => ({
  id,
  type,
  slug: id,
  branchName,
});

const BASE = [env("prod", "PRODUCTION"), env("stg", "STAGING"), env("dev", "DEVELOPMENT")];
const ROW = { channelId: "ch_1", channelName: "Ops email", alertType: "TASK_RUN" };

function replaceAnswers(environments: ReplaceEnvironment[] = BASE): FlowAnswers {
  return prefillToAnswers(replacePrefill(ROW, environments));
}

function makeFlow(answers: FlowAnswers, overrides: Partial<CreationFlowState> = {}) {
  return {
    answers,
    currentStep: "environments",
    completedSteps: [],
    isReview: false,
    created: false,
    createdAlertId: undefined,
    submitting: false,
    submitError: false,
    selectChip: noop,
    setCondition: noop,
    setConditionParams: noop,
    confirmCondition: noop,
    setScopeValue: noop,
    setWindowMinutes: noop,
    toggleNotifier: noop,
    confirmNotifiers: noop,
    setExpiry: noop,
    create: noop,
    reset: noop,
    patchAnswers: noop,
    ...overrides,
  } as CreationFlowState;
}

describe("replace prefill", () => {
  it("answers everything up to scope and checks every non-preview environment", () => {
    const answers = replaceAnswers([...BASE, env("pr1", "PREVIEW", "feat")]);
    expect(answers).toMatchObject({
      area: "runs",
      what: "runs.failed",
      condition: "0",
      scope: "all",
      notifiers: ["ch_1"],
      environments: ["prod", "stg", "dev"],
    });
    expect(answers.expiry).toBeUndefined();
    expect(alertName(answers)).toBe("Failed runs · Ops email");
    expect(draftMissing(answers)).toEqual(["environments"]);
  });
});

describe("environments step", () => {
  it("is present only in replace mode, right after scope", () => {
    const replace = allSteps(makeFlow(replaceAnswers()), [], undefined).map((s) => s.id);
    expect(replace.indexOf("environments")).toBe(replace.indexOf("scope") + 1);
    const plain = allSteps(
      makeFlow({ area: "runs", what: "runs.failed", condition: "0", scope: "all" }),
      [],
      undefined
    ).map((s) => s.id);
    expect(plain).not.toContain("environments");
  });

  it("lists the environments with the description and locks scope to all", () => {
    const steps = allSteps(makeFlow(replaceAnswers()), [], "chat_1");
    const step = steps.find((s) => s.id === "environments")!;
    expect(step.description).toBe(DESCRIPTION);
    expect(step.multiSelect).toBe(true);
    expect(step.options.map((o) => o.label)).toEqual(["Production", "Staging", "Development"]);
    expect(step.selected).toEqual(["prod", "stg", "dev"]);
    const scope = steps.find((s) => s.id === "scope")!;
    expect(scope.entity).toBeUndefined();
    expect(scope.options.filter((o) => !o.disabledReason).map((o) => o.id)).toEqual(["all"]);
    const notifiers = allSteps(
      makeFlow(replaceAnswers()),
      [
        { id: "ch_1", name: "Ops email", type: "EMAIL" },
        { id: "ch_2", name: "Slack", type: "SLACK" },
      ],
      "chat_1",
      { projectId: "p", canWrite: true, atLimit: false }
    ).find((s) => s.id === "notifiers")!;
    expect(notifiers.options.map((o) => o.id)).toEqual(["chat", "ch_1", "ch_2", "__add_channel__"]);
    expect(notifiers.selected).toEqual(["ch_1"]);

    const twice = allSteps(
      makeFlow(replaceAnswers()),
      [
        { id: "ch_1", name: "Ops email", type: "EMAIL" },
        { id: "ch_1", name: "Ops email", type: "EMAIL" },
      ],
      undefined
    ).find((s) => s.id === "notifiers")!;
    expect(twice.options.map((o) => o.id)).toEqual(["ch_1"]);
    expect(twice.selected).toEqual(["ch_1"]);
  });

  it("expands the preview group in place and picks previews one by one", () => {
    const previews = ["a", "b"].map((b) => env(`pr_${b}`, "PREVIEW", b));
    const answers = replaceAnswers([...BASE, ...previews]);
    const collapsed = allSteps(makeFlow(answers), [], undefined).find(
      (s) => s.id === "environments"
    )!;
    expect(collapsed.options.map((o) => o.label)).toEqual([
      "Production",
      "Staging",
      "Development",
      "Preview (2)",
    ]);
    expect(collapsed.selected).toEqual(["prod", "stg", "dev"]);

    const patches: FlowAnswers[] = [];
    const handlers = { onShowAll: noop, onAddChannel: noop };
    applyStepSelection(
      makeFlow(answers, { patchAnswers: (next) => patches.push(next) }),
      "environments",
      PREVIEW_GROUP,
      handlers
    );
    expect(patches[0]!.previewsExpanded).toBe(true);
    expect(patches[0]!.environments).toEqual(["prod", "stg", "dev"]);

    const expanded = allSteps(makeFlow(patches[0]!), [], undefined).find(
      (s) => s.id === "environments"
    )!;
    expect(expanded.options.map((o) => o.id)).toEqual([
      "prod",
      "stg",
      "dev",
      PREVIEW_GROUP,
      "pr_a",
      "pr_b",
    ]);
    applyStepSelection(
      makeFlow(patches[0]!, { patchAnswers: (next) => patches.push(next) }),
      "environments",
      "pr_b",
      handlers
    );
    expect(patches[1]!.environments).toEqual(["prod", "stg", "dev", "pr_b"]);
  });

  it("confirms the step so the flow moves on", () => {
    const patches: FlowAnswers[] = [];
    const flow = makeFlow(replaceAnswers(), { patchAnswers: (next) => patches.push(next) });
    confirmStep(flow, "environments");
    expect(patches[0]!.environmentsConfirmed).toBe(true);
    expect(draftMissing(patches[0]!)).toEqual([]);
  });
});
