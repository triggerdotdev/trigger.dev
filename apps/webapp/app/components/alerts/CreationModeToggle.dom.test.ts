// @vitest-environment jsdom
import { act, createElement, useState } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vitest";
import { OperatingSystemContextProvider } from "~/components/primitives/OperatingSystemProvider";
import { ShortcutsProvider } from "~/components/primitives/ShortcutsProvider";
import type { CreationFlowState } from "~/components/dashboard-agent/alert-creation/CreationFlow";
import { CreationTranscript } from "./CreationTranscript";

const noop = () => {};
const flow = {
  answers: {},
  currentStep: "area",
  completedSteps: [],
  selectChip: noop,
} as unknown as CreationFlowState;

function Harness() {
  const [manual, setManual] = useState(false);
  return createElement(CreationTranscript, {
    flow,
    manual,
    onManualChange: setManual,
    onFreeText: noop,
    onNewChat: noop,
  });
}

describe("Agent/Manual toggle", () => {
  it("stays mounted when the mode switches so the pill can animate", () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    act(() => {
      root.render(
        createElement(
          OperatingSystemContextProvider,
          { platform: "mac" },
          createElement(ShortcutsProvider, null, createElement(Harness))
        )
      );
    });
    const before = container.querySelector('[role="radiogroup"]');
    expect(before).not.toBeNull();
    const manualButton = container.querySelector('[role="radio"][aria-label^="Manual"]')!;
    act(() => (manualButton as HTMLButtonElement).click());
    expect(container.querySelector('[role="radio"][aria-checked="true"]')?.textContent).toContain(
      "Manual"
    );
    expect(container.querySelector('[role="radiogroup"]')).toBe(before);
    act(() => root.unmount());
    container.remove();
  });
});
