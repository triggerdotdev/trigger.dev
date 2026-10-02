// @vitest-environment jsdom
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it } from "vitest";
import { OperatingSystemContextProvider } from "~/components/primitives/OperatingSystemProvider";
import { ShortcutsProvider } from "~/components/primitives/ShortcutsProvider";
import { LinkButton, newTabRel } from "./Buttons";

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

function renderLinkButton(props: Parameters<typeof LinkButton>[0]) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(
      createElement(
        MemoryRouter,
        null,
        createElement(
          OperatingSystemContextProvider,
          { platform: "mac" },
          createElement(ShortcutsProvider, null, createElement(LinkButton, props))
        )
      )
    );
  });
  const anchor = container.querySelector("a");
  if (!anchor) throw new Error("LinkButton did not render an anchor");
  return anchor;
}

describe("LinkButton /resources targets", () => {
  it("keeps an offloaded packet href exactly as built", () => {
    const to = "/resources/packets/env1/s3://run_abc/output.json";
    const anchor = renderLinkButton({ to, variant: "secondary/small", download: true });

    expect(anchor.getAttribute("href")).toBe(to);
    expect(anchor.getAttribute("rel")).toBe("noopener");
  });

  it("opens in a new tab, downloads, and keeps the Referer", () => {
    const anchor = renderLinkButton({
      to: "/resources/runs/run_1/logs/download",
      variant: "secondary/small",
      download: true,
    });

    expect(anchor.getAttribute("href")).toBe("/resources/runs/run_1/logs/download");
    expect(anchor.getAttribute("target")).toBe("_blank");
    expect(anchor.hasAttribute("download")).toBe(true);
    expect(anchor.getAttribute("rel")).toBe("noopener");
  });
});

describe("newTabRel", () => {
  it("drops the Referer for protocol-relative and absolute URLs", () => {
    expect(newTabRel("//example.com/x")).toBe("noopener noreferrer");
    expect(newTabRel("https://example.com/x")).toBe("noopener noreferrer");
  });
});
