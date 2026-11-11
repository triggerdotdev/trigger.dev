// @vitest-environment jsdom
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { act } from "react-dom/test-utils";
import { describe, expect, it, vi } from "vitest";
import { OperatingSystemContextProvider } from "~/components/primitives/OperatingSystemProvider";
import { ShortcutsProvider } from "~/components/primitives/ShortcutsProvider";
import { ActionsBlock } from "./ActionsBlock";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const block = {
  type: "actions",
  id: "a",
  revision: 0,
  version: 1,
  actions: [{ label: "Dig deeper", intent: { kind: "ask", prompt: "Dig deeper" } }],
} as never;

async function clickWith(accepted: boolean) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const onIntent = vi.fn(() => accepted);
  await act(async () => {
    root.render(
      createElement(
        OperatingSystemContextProvider,
        { platform: "mac" },
        createElement(ShortcutsProvider, null, createElement(ActionsBlock, { block, onIntent }))
      )
    );
  });
  const button = container.querySelector("button")!;
  await act(async () => {
    button.click();
  });
  const disabled = button.disabled;
  act(() => root.unmount());
  container.remove();
  return { disabled, onIntent };
}

describe("ActionsBlock", () => {
  // Catches: the ask button retiring when the submission was refused (streaming or message cap).
  it("retires the button only when the submission is accepted", async () => {
    expect((await clickWith(true)).disabled).toBe(true);
    const refused = await clickWith(false);
    expect(refused.onIntent).toHaveBeenCalledTimes(1);
    expect(refused.disabled).toBe(false);
  });
});
