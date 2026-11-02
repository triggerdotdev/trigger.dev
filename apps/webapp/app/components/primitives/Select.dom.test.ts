// @vitest-environment jsdom
import { createElement, type ComponentProps } from "react";
import { act } from "react-dom/test-utils";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { OperatingSystemContextProvider } from "./OperatingSystemProvider";
import { Select, SelectItem } from "./Select";
import { ShortcutsProvider } from "./ShortcutsProvider";

let root: Root | undefined;
let container: HTMLElement | undefined;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
});

const pressKeyWithoutCode = () =>
  act(() => {
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Unidentified", code: "", bubbles: true })
    );
  });

describe("Select", () => {
  // Mutation: dropping the empty-key guard in useShortcutKeys fails this.
  it("ignores a keydown without a key code", () => {
    const picked: string[] = [];
    const setValue = (value: string) => {
      picked.push(value);
    };
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() =>
      root!.render(
        createElement(
          OperatingSystemContextProvider,
          { platform: "mac" } as ComponentProps<typeof OperatingSystemContextProvider>,
          createElement(
            ShortcutsProvider,
            null,
            createElement(
              Select<string, string>,
              { "aria-label": "pick", items: ["a", "b"], value: "", setValue } as never,
              ((list: string[]) =>
                list.map((id) => createElement(SelectItem, { key: id, value: id }, id))) as never
            )
          )
        )
      )
    );
    const trigger = container.querySelector<HTMLButtonElement>("button[role=combobox]")!;

    pressKeyWithoutCode();
    expect(trigger.getAttribute("aria-expanded")).toBe("false");

    act(() => trigger.click());
    pressKeyWithoutCode();
    expect(picked).toEqual([]);
  });
});
