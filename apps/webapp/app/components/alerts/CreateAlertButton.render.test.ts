// @vitest-environment jsdom
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NEW_ERROR_ALERT_PREFILL, errorGroupAlertPrefill } from "./errorAlertPrefill";
import { DashboardAgentProvider } from "~/components/dashboard-agent/dashboardAgentLauncher";
import { OperatingSystemContextProvider } from "~/components/primitives/OperatingSystemProvider";
import { ShortcutsProvider } from "~/components/primitives/ShortcutsProvider";

globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

vi.mock("@remix-run/react", async () => {
  const React = await import("react");
  return {
    Link: ({ to, children, ...rest }: any) =>
      React.createElement("a", { href: to, ...rest }, children),
    useNavigation: () => ({ state: "idle" }),
  };
});

const { CreateAlertButton } = await import("./CreateAlertButton");

const GROUP_PREFILL = errorGroupAlertPrefill("my-task", "fp123");

let container: HTMLDivElement | undefined;
let root: Root | undefined;

afterEach(() => {
  if (root) act(() => root!.unmount());
  container?.remove();
  container = undefined;
  root = undefined;
});

function render(agent: unknown, prefill: any) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const button = createElement(CreateAlertButton, {
    prefill,
    organization: { slug: "org" },
    project: { slug: "proj" },
    environment: { slug: "dev" },
  });
  act(() => {
    root!.render(
      createElement(
        OperatingSystemContextProvider,
        { platform: "mac" },
        createElement(
          ShortcutsProvider,
          null,
          createElement(DashboardAgentProvider, { value: agent as any }, button)
        )
      )
    );
  });
  return container;
}

describe("CreateAlertButton on the Errors pages", () => {
  it("opens the agent with the structured error group scope", () => {
    const openCreateAlert = vi.fn();
    const el = render({ openCreateAlert }, GROUP_PREFILL);
    act(() => el.querySelector("button")!.click());
    expect(openCreateAlert).toHaveBeenCalledWith({
      capability: "errors.occurred_again",
      scope: { type: "errorGroup", taskIdentifier: "my-task", fingerprint: "fp123" },
    });
  });

  it("falls back to a link carrying the encoded group", () => {
    const el = render(null, GROUP_PREFILL);
    const href = el.querySelector("a")!.getAttribute("href")!;
    expect(href).toContain("capability=errors.occurred_again");
    expect(href).toContain("scope=errorGroup");
    expect(href).toContain(`scopeValue=${encodeURIComponent("my-task#fp123")}`);
  });

  it("prefills errors.new with scope all", () => {
    const openCreateAlert = vi.fn();
    const el = render({ openCreateAlert }, NEW_ERROR_ALERT_PREFILL);
    act(() => el.querySelector("button")!.click());
    expect(openCreateAlert).toHaveBeenCalledWith({ capability: "errors.new", scope: "all" });
  });
});
