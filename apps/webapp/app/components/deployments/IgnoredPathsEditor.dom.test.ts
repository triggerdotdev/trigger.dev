// @vitest-environment jsdom
// Component test beside its component, like the other deployments tests: typing and folding have no route seam.
import { EditorView } from "@codemirror/view";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OperatingSystemContextProvider } from "../primitives/OperatingSystemProvider";
import { ShortcutsProvider } from "../primitives/ShortcutsProvider";
import { IgnoredPathsEditor } from "./IgnoredPathsEditor";

globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

let container: HTMLDivElement;
let root: Root;

function mount(defaultPatterns: string[] = [], limits = { maxPaths: 100, maxLength: 256 }) {
  const onChange = vi.fn();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => {
    root.render(
      createElement(
        OperatingSystemContextProvider,
        { platform: "mac" },
        createElement(
          ShortcutsProvider,
          null,
          createElement(IgnoredPathsEditor, {
            name: "ignorePaths",
            defaultPatterns,
            limits,
            onChange,
          })
        )
      )
    );
  });
  return onChange;
}

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function editor() {
  return EditorView.findFromDOM(container.querySelector<HTMLElement>(".cm-editor")!)!;
}

function edit(text: string) {
  const view = editor();
  act(() => {
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } });
  });
}

function submitted() {
  return container.querySelector<HTMLInputElement>('input[name="ignorePaths"]')!.value;
}

function button(label: string) {
  return container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
}

function tester() {
  return container.querySelector<HTMLInputElement>('input[aria-label="Path to test"]');
}

function type(value: string) {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
      tester(),
      value
    );
    tester()!.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function press(key: string) {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
  act(() => {
    tester()!.dispatchEvent(event);
  });
  return event.defaultPrevented;
}

function verdict() {
  return [...container.querySelector('[role="status"]')!.children].map((part) => part.textContent);
}

function errors() {
  return [...container.querySelectorAll("li")].map((item) => item.textContent);
}

describe("IgnoredPathsEditor", () => {
  it("folds more than three saved paths and expands into the editor", () => {
    const paths = "docs/**\napps/website/**\n**/*.md\n.github/**\nexamples/**";
    mount(paths.split("\n"));

    expect(button("Expand")).not.toBeNull();
    expect(submitted()).toBe(paths);

    act(() => button("Expand")!.click());
    expect(editor().hasFocus).toBe(true);
    expect(button("Collapse")).not.toBeNull();

    act(() => button("Collapse")!.click());
    expect(button("Expand")).not.toBeNull();
  });

  it("starts with a note that every push deploys and reports typed paths", () => {
    const onChange = mount();
    expect(container.textContent).toContain(
      "No paths yet, so every push to a tracked branch deploys."
    );
    expect(button("Expand")).toBeNull();

    edit("  docs/**  \n\n*.md\n");

    expect(submitted()).toBe("  docs/**  \n\n*.md\n");
    expect(onChange).toHaveBeenLastCalledWith(["docs/**", "*.md"], true);
    expect(container.textContent).not.toContain("No paths yet");
  });

  it("lists each invalid line and marks the editor invalid", () => {
    const onChange = mount();
    edit("docs/**\n!src/**\nexamples/\n**/*.{md,mdx}");

    expect(errors()).toEqual([
      "Line 2: Negated patterns aren't supported. List only the paths to ignore.",
      "Line 3: Matches no files. Use examples/** for everything in the directory.",
      "Line 4: Braces aren't supported. Put each alternative on its own line.",
    ]);
    expect(container.textContent).toContain("3 errors");
    expect(editor().contentDOM.getAttribute("aria-invalid")).toBe("true");
    expect(onChange).toHaveBeenLastCalledWith(
      ["docs/**", "!src/**", "examples/", "**/*.{md,mdx}"],
      false
    );
  });

  it("applies the configured path count and length limits", () => {
    const onChange = mount(["docs/**", "*.md"], { maxPaths: 2, maxLength: 10 });

    edit("docs/**\n*.md\nexamples/**/*.ts");

    expect(errors()).toEqual(["Line 3: Use at most 10 characters.", "Add at most 2 paths."]);
    expect(onChange).toHaveBeenLastCalledWith(["docs/**", "*.md", "examples/**/*.ts"], false);
  });

  it("tests a path against the saved paths while folded", () => {
    mount(["docs/**", "apps/website/**", "**/*.md", ".github/**"]);
    act(() => button("Test a path")!.click());
    expect(document.activeElement).toBe(tester());
    expect(button("Expand")).not.toBeNull();

    type("apps/website/src/index.tsx");
    expect(verdict()).toEqual(["Ignored", "by apps/website/**"]);

    type("src/index.ts");
    expect(verdict()).toEqual(["Deploys", "no path matches"]);

    expect(press("Enter")).toBe(true);
    press("Escape");
    expect(tester()).toBeNull();
    expect(document.activeElement).toBe(button("Test a path"));

    act(() => button("Test a path")!.click());
    expect(tester()!.value).toBe("");
  });

  it("updates the verdict when the paths change", () => {
    mount(["docs/**", "*.md"]);
    act(() => button("Test a path")!.click());
    type("docs/guide.md");
    expect(verdict()).toEqual(["Ignored", "by docs/**"]);

    edit("src/**\n**/*.md");
    expect(verdict()).toEqual(["Ignored", "by **/*.md"]);

    edit("src/**\n!docs/**");
    expect(verdict()).toEqual(["Deploys", "no path matches"]);
  });

  it("offers the tester only once there is a valid path", () => {
    mount();
    expect(button("Test a path")).toBeNull();

    edit("!src/**");
    expect(button("Test a path")).toBeNull();

    edit("!src/**\ndocs/**");
    expect(button("Test a path")).not.toBeNull();

    act(() => button("Test a path")!.click());
    edit("!src/**");
    expect(button("Close the path tester")).not.toBeNull();
  });
});
