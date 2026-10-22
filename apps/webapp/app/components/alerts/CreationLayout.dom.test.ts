// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { OperatingSystemContextProvider } from "~/components/primitives/OperatingSystemProvider";
import { ShortcutsProvider } from "~/components/primitives/ShortcutsProvider";
import type { CreationFlowState } from "~/components/dashboard-agent/alert-creation/CreationFlow";
import { CreationChatShell } from "./CreationChatShell";
import { CreationTranscript } from "./CreationTranscript";

const noop = () => {};

const flow = {
  answers: {},
  currentStep: "area",
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
} as unknown as CreationFlowState;

describe("new alert panel layout", () => {
  it("pins the composer to the bottom of a filling flex column", () => {
    const html = renderToStaticMarkup(
      createElement(
        OperatingSystemContextProvider,
        { platform: "mac" },
        createElement(
          ShortcutsProvider,
          null,
          createElement(
            CreationChatShell,
            { placement: "docked", title: "New alert" },
            createElement(CreationTranscript, {
              flow,
              onFreeText: noop,
              onManualChange: noop,
              onNewChat: noop,
            })
          )
        )
      )
    );
    const shell = new DOMParser()
      .parseFromString(html, "text/html")
      .querySelector('[data-testid="creation-chat-shell"]')!;
    expect(shell.classList).toContain("flex-1");
    expect(shell.classList).toContain("min-h-0");
    expect(shell.classList).toContain("flex-col");
    const transcript = shell.firstElementChild!;
    expect(transcript.classList).toContain("flex-1");
    expect(transcript.querySelector('[data-testid="creation-flow"]')).not.toBeNull();
    const composer = shell.lastElementChild!;
    expect(composer).not.toBe(transcript);
    expect(composer.querySelector("textarea")).not.toBeNull();
    expect(composer.querySelector('[aria-label="New chat"]')).not.toBeNull();
    expect(composer.textContent).toContain("Agent");
  });
});

describe("Show me what I can watch", () => {
  it("opens the scenarios card without asking the agent", () => {
    const onFreeText = vi.fn();
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    act(() => {
      root.render(
        createElement(
          OperatingSystemContextProvider,
          { platform: "mac" },
          createElement(
            ShortcutsProvider,
            null,
            createElement(CreationTranscript, { flow, onFreeText })
          )
        )
      );
    });
    const row = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent?.trim() === "Show me what I can watch"
    )!;
    act(() => row.click());
    expect(onFreeText).not.toHaveBeenCalled();
    expect(container.querySelector("[role=dialog]")?.getAttribute("aria-label")).toBe(
      "What can I watch?"
    );
    act(() => root.unmount());
    container.remove();
  });
});
