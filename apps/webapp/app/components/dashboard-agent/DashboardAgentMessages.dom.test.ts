// @vitest-environment jsdom
import type { UIMessage } from "@ai-sdk/react";
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { act } from "react-dom/test-utils";
import { afterEach, describe, expect, it } from "vitest";
import { OperatingSystemContextProvider } from "~/components/primitives/OperatingSystemProvider";
import { ShortcutsProvider } from "~/components/primitives/ShortcutsProvider";
import { DashboardAgentTurns } from "./DashboardAgentMessages";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const message = (id: string, role: string, text: string) =>
  ({ id, role, parts: [{ type: "text", text }] }) as unknown as UIMessage;

const originalClipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");

afterEach(() => {
  if (originalClipboard) Object.defineProperty(navigator, "clipboard", originalClipboard);
  else delete (navigator as { clipboard?: unknown }).clipboard;
});

async function copiedByEachButton(messages: UIMessage[], activity: "working" | null) {
  const written: string[] = [];
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: (value: string) => void written.push(value) },
  });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      createElement(
        OperatingSystemContextProvider,
        { platform: "mac" },
        createElement(
          ShortcutsProvider,
          null,
          createElement(DashboardAgentTurns, { messages, activity, onIntent: () => {} })
        )
      )
    );
  });
  for (const button of container.querySelectorAll<HTMLButtonElement>('button[aria-label="Copy"]')) {
    await act(async () => {
      button.click();
    });
  }
  act(() => root.unmount());
  container.remove();
  return written;
}

describe("copy button value", () => {
  it("copies every message of a series", async () => {
    const messages = [
      message("a", "assistant", "FIRST"),
      message("b", "assistant", "SECOND"),
      message("c", "assistant", "THIRD"),
    ];
    expect(await copiedByEachButton(messages, null)).toEqual(["FIRST\n\nSECOND\n\nTHIRD"]);
  });

  it("belongs to the settled series when a later reply is in progress", async () => {
    const messages = [
      message("a", "assistant", "SETTLED"),
      message("u", "user", "question"),
      message("b", "assistant", "IN_PROGRESS"),
    ];
    expect(await copiedByEachButton(messages, "working")).toEqual(["SETTLED"]);
  });
});
