// @vitest-environment jsdom
import { createElement, useEffect } from "react";
import type * as remixReact from "@remix-run/react";
import { act } from "react-dom/test-utils";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CreationTranscript } from "~/components/alerts/CreationTranscript";
import { OperatingSystemContextProvider } from "~/components/primitives/OperatingSystemProvider";
import { ShortcutsProvider } from "~/components/primitives/ShortcutsProvider";
import { useCreationFlowState } from "./CreationFlow";
import { prefillToAnswers, replacePrefill } from "./flow-state";

vi.mock("@remix-run/react", async (importOriginal) => ({
  ...(await importOriginal<typeof remixReact>()),
  useFetcher: () => ({ data: undefined, load: () => {} }),
}));
vi.mock("~/hooks/useOrganizations", () => ({ useOptionalOrganization: () => undefined }));
vi.mock("~/hooks/useProject", () => ({ useOptionalProject: () => undefined }));
vi.mock("~/hooks/useEnvironment", () => ({ useOptionalEnvironment: () => undefined }));

let container: HTMLElement | undefined;
let root: Root | undefined;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
});

const initial = prefillToAnswers(
  replacePrefill({ channelId: "ch_1", channelName: "Ops", alertType: "TASK_RUN" }, [
    { id: "prod", type: "PRODUCTION", slug: "prod", branchName: null },
    { id: "pr_a", type: "PREVIEW", slug: "pr_a", branchName: "feat-a" },
    { id: "pr_b", type: "PREVIEW", slug: "pr_b", branchName: "feat-b" },
  ])
);

let latest: ReturnType<typeof useCreationFlowState> | undefined;

function Harness() {
  const flow = useCreationFlowState(vi.fn(), initial);
  useEffect(() => {
    latest = flow;
  });
  return createElement(CreationTranscript, {
    flow,
    channels: [{ id: "ch_1", name: "Ops", type: "EMAIL" }],
    manual: true,
    onManualChange: () => {},
  });
}

function mount() {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() =>
    root!.render(
      createElement(
        OperatingSystemContextProvider,
        { platform: "mac" },
        createElement(ShortcutsProvider, null, createElement(Harness))
      )
    )
  );
}

describe("manual replace form", () => {
  it("expands the preview group in place on click", () => {
    mount();
    const step = container!.querySelector('fieldset[data-step="environments"]')!;
    expect(step.textContent).not.toContain("feat-a");
    const group = step.querySelector<HTMLButtonElement>("button[aria-expanded]")!;
    expect(group.textContent).toContain("Preview (2)");
    expect(group.getAttribute("aria-expanded")).toBe("false");
    const chevron = group.querySelector("[data-expander]")!;
    expect(chevron.getAttribute("class")).not.toContain("invisible");
    expect(chevron.getAttribute("class")).toContain("-rotate-90");

    act(() => group.click());

    const expanded = container!.querySelector('fieldset[data-step="environments"]')!;
    expect(expanded.textContent).toContain("feat-a");
    expect(expanded.textContent).toContain("feat-b");
    expect(expanded.querySelector("button[aria-expanded]")!.getAttribute("aria-expanded")).toBe(
      "true"
    );
    expect(expanded.querySelector("[data-expander]")!.getAttribute("class")).not.toContain(
      "-rotate-90"
    );
  });

  it("still expands the preview group once the review is shown", () => {
    mount();
    act(() => latest!.setExpiry("none"));
    act(() => latest!.confirmNotifiers());
    expect(latest!.isReview).toBe(true);
    const group = container!.querySelector<HTMLButtonElement>(
      'fieldset[data-step="environments"] button[aria-expanded]'
    )!;
    act(() => group.click());
    expect(container!.querySelector('fieldset[data-step="environments"]')!.textContent).toContain(
      "feat-a"
    );
  });
});
