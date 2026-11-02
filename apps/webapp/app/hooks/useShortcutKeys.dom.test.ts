// @vitest-environment jsdom
import { createElement, type ComponentProps } from "react";
import { act } from "react-dom/test-utils";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { OperatingSystemContextProvider } from "~/components/primitives/OperatingSystemProvider";
import { ShortcutsProvider } from "~/components/primitives/ShortcutsProvider";
import { type Shortcut, useShortcutKeys } from "./useShortcutKeys";

let root: Root | undefined;
let container: HTMLElement | undefined;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
});

function Probe({ shortcut, action }: { shortcut?: Shortcut; action: () => void }) {
  useShortcutKeys({ shortcut, action });
  return null;
}

describe("useShortcutKeys", () => {
  // Mutation: dropping the empty-key guard fails the undefined-shortcut row.
  it.each([
    { name: "undefined shortcut", shortcut: undefined, key: "Unidentified", code: "", calls: 0 },
    { name: "a real key", shortcut: { key: "k" }, key: "k", code: "KeyK", calls: 1 },
  ])("$name", ({ shortcut, key, code, calls }) => {
    let fired = 0;
    const action = () => {
      fired++;
    };
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() =>
      root!.render(
        createElement(
          OperatingSystemContextProvider,
          { platform: "mac" } as ComponentProps<typeof OperatingSystemContextProvider>,
          createElement(ShortcutsProvider, null, createElement(Probe, { shortcut, action }))
        )
      )
    );
    act(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key, code, bubbles: true }));
    });
    expect(fired).toBe(calls);
  });
});
