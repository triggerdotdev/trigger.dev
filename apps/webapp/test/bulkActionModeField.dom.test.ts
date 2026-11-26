// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BulkActionModeField,
  type BulkActionModeValue,
} from "~/components/runs/v3/BulkActionModeField";

let root: Root | undefined;
let container: HTMLElement | undefined;

beforeEach(() => {
  // The radio indicator measures itself; jsdom has no ResizeObserver.
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  );
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  vi.unstubAllGlobals();
});

function render(mode: BulkActionModeValue) {
  act(() =>
    root!.render(
      createElement(
        "form",
        null,
        createElement(BulkActionModeField, {
          mode,
          onModeChange: () => {},
          filterLabel: "All runs matching your filters",
          selectedLabel: "1 individually selected run",
        })
      )
    )
  );
}

describe("BulkActionModeField", () => {
  // Catches: the panel opened on "matching your filters", a shortcut switching it to the
  // selected runs (the button then reads "Replay 1 runs"), and the form still submitting
  // mode=filter, which acts on every matching run.
  it("submits the mode it was last given", () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    render("filter");
    const form = container.querySelector("form")!;
    expect(new FormData(form).get("mode")).toBe("filter");

    render("selected");
    expect(new FormData(form).get("mode")).toBe("selected");
    expect(container.querySelector("#mode-selected")?.getAttribute("aria-checked")).toBe("true");
  });
});
