import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { OperatingSystemContextProvider } from "~/components/primitives/OperatingSystemProvider";
import { ShortcutsProvider } from "~/components/primitives/ShortcutsProvider";
import type { CreationFlowState } from "~/components/dashboard-agent/alert-creation/CreationFlow";
import {
  prefillToAnswers,
  replacePrefill,
  type FlowAnswers,
  type ReplaceEnvironment,
} from "~/components/dashboard-agent/alert-creation/flow-state";
import { CreationTranscript } from "./CreationTranscript";

vi.mock("~/hooks/useOrganizations", () => ({ useOptionalOrganization: () => undefined }));
vi.mock("~/hooks/useProject", () => ({ useOptionalProject: () => undefined }));
vi.mock("~/hooks/useEnvironment", () => ({ useOptionalEnvironment: () => undefined }));

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

function wrap(el: React.ReactElement): string {
  return renderToStaticMarkup(
    createElement(
      OperatingSystemContextProvider,
      { platform: "mac" },
      createElement(ShortcutsProvider, null, el)
    )
  );
}

describe("environments step render", () => {
  it("renders the environment options in the chat wizard card", () => {
    const html = wrap(
      createElement(CreationTranscript, {
        flow: makeFlow(replaceAnswers()),
        density: "compact",
        onFreeText: noop,
      })
    );
    expect(html).toContain(DESCRIPTION);
    expect(html).toContain("Production");
    expect(html).toContain("Development");
  });

  it("renders the environment options in the manual form", () => {
    const html = wrap(
      createElement(CreationTranscript, {
        flow: makeFlow(replaceAnswers()),
        density: "compact",
        manual: true,
        onManualChange: noop,
      })
    );
    expect(html).toContain('data-step="environments"');
    expect(html).toContain('data-step="expiry"');
    expect(html).toContain('data-step="notifiers"');
    expect(html).not.toContain("Continue");
    expect(html).toContain(DESCRIPTION);
    expect(html).toContain("Staging");
  });

  it("lists each preview as its own checkbox once the group is expanded", () => {
    const previews = [env("pr_a", "PREVIEW", "feat-a"), env("pr_b", "PREVIEW", "feat-b")];
    const render = (answers: FlowAnswers) =>
      wrap(
        createElement(CreationTranscript, {
          flow: makeFlow(answers),
          density: "compact",
          manual: true,
          onManualChange: noop,
        })
      );
    const answers = replaceAnswers([...BASE, ...previews]);
    const collapsed = render(answers);
    expect(collapsed).toContain("Preview (2)");
    expect(collapsed).not.toContain("feat-a");

    const expanded = render({ ...answers, previewsExpanded: true });
    expect(expanded).toContain('aria-expanded="true"');
    expect(expanded).toContain("feat-a");
    expect(expanded).toContain("feat-b");
    const boxes = (html: string) => html.match(/type="checkbox"/g)?.length ?? 0;
    expect(boxes(expanded) - boxes(collapsed)).toBe(2);
  });

  it("draws no trailing arrows on multi-select rows and a chevron only for the open group", () => {
    const previews = [env("pr_a", "PREVIEW", "feat-a")];
    const card = (answers: FlowAnswers) =>
      wrap(
        createElement(CreationTranscript, {
          flow: makeFlow(answers),
          density: "compact",
          onFreeText: noop,
        })
      );
    const answers = replaceAnswers([...BASE, ...previews]);
    const collapsed = card(answers);
    const arrow = /M3 10a\.75\.75 0 01\.75-\.75h10\.638/;
    expect(collapsed).not.toMatch(arrow);
    expect(collapsed).toContain('aria-expanded="false"');
    expect(collapsed).toMatch(/data-expander="true" class="[^"]*invisible/);

    const open = card({ ...answers, previewsExpanded: true });
    expect(open).toContain('aria-expanded="true"');
    expect(open).not.toMatch(/data-expander="true" class="[^"]*invisible/);
    expect(open).toContain("feat-a");
    expect(open).not.toMatch(arrow);
  });
});
