// @vitest-environment jsdom
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";
import { afterEach, describe, expect, it } from "vitest";
import { RuntimeIcon } from "~/components/RuntimeIcon";

let container: HTMLDivElement | undefined;
let root: Root | undefined;

afterEach(() => {
  if (root) {
    act(() => root!.unmount());
  }
  container?.remove();
  container = undefined;
  root = undefined;
});

function render(props: { runtime?: string | null; runtimeVersion?: string | null }) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(createElement(RuntimeIcon, { ...props, withLabel: true }));
  });
  return container.textContent ?? "";
}

describe("RuntimeIcon", () => {
  const unknownRuntimes: (string | null | undefined)[] = [null, undefined, "", "deno"];

  it.each(unknownRuntimes)("does not claim Node.js for runtime %o", (runtime) => {
    const text = render({ runtime, runtimeVersion: null });

    expect(text).not.toContain("Node.js");
    expect(text).toContain("–");
  });

  it("does not claim Node.js when only a version is recorded", () => {
    const text = render({ runtime: null, runtimeVersion: "24.9.0" });

    expect(text).not.toContain("Node.js");
    expect(text).not.toContain("24.9.0");
  });

  it("labels a bun runtime as Bun", () => {
    expect(render({ runtime: "bun", runtimeVersion: "1.2.23" })).toContain("Bun v1.2.23");
  });

  it("labels a node runtime as Node.js", () => {
    expect(render({ runtime: "node-24", runtimeVersion: "24.9.0" })).toContain("Node.js v24.9.0");
  });
});
