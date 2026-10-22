// @vitest-environment jsdom
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TaskRunStatus } from "@trigger.dev/database";
import { DashboardAgentProvider } from "~/components/dashboard-agent/dashboardAgentLauncher";
import { OperatingSystemContextProvider } from "~/components/primitives/OperatingSystemProvider";
import { ShortcutsProvider } from "~/components/primitives/ShortcutsProvider";
import { isFinalRunStatus } from "~/v3/taskStatus";

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

const { RunCreateAlertButton } = await import("./RunCreateAlertButton");

const organization = { slug: "org" };
const project = { slug: "proj" };
const environment = { slug: "dev" };

let container: HTMLDivElement | undefined;
let root: Root | undefined;

afterEach(() => {
  if (root) act(() => root!.unmount());
  container?.remove();
  container = undefined;
  root = undefined;
});

function render(agent: unknown) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const button = createElement(RunCreateAlertButton, {
    taskIdentifier: "my-task",
    organization,
    project,
    environment,
  } as any);
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

function renderWithStatus(agent: unknown, runStatus: TaskRunStatus) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const button = isFinalRunStatus(runStatus)
    ? null
    : createElement(RunCreateAlertButton, {
        taskIdentifier: "my-task",
        organization,
        project,
        environment,
      } as any);
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

describe("RunCreateAlertButton", () => {
  it("opens the agent card prefilled with the task identifier", () => {
    const openCreateAlert = vi.fn();
    const el = render({ openCreateAlert });
    const button = el.querySelector("button")!;
    expect(button.textContent).toContain("Watch");
    act(() => button.click());
    expect(openCreateAlert).toHaveBeenCalledWith({
      area: "runs",
      scope: "task",
      scopeValue: "my-task",
    });
    expect(openCreateAlert.mock.calls[0]![0]).not.toHaveProperty("capability");
  });

  it("falls back to a prefilled link when the agent is unavailable", () => {
    const el = render(null);
    const href = el.querySelector("a")!.getAttribute("href")!;
    const params = new URL(href, "http://localhost").searchParams;
    expect(params.get("create")).toBe("1");
    expect(params.get("area")).toBe("runs");
    expect(params.get("scope")).toBe("task");
    expect(params.get("scopeValue")).toBe("my-task");
    expect(params.has("capability")).toBe(false);
  });

  it("shows the tooltip on focus", () => {
    render({ openCreateAlert: vi.fn() });
    const button = document.querySelector("button")!;
    act(() => {
      button.dispatchEvent(new FocusEvent("focus"));
      (button as HTMLElement).focus();
    });
    expect(document.body.textContent).toContain("Create a new alert");
  });

  it("hides Watch button for completed runs", () => {
    const el = renderWithStatus({ openCreateAlert: vi.fn() }, "COMPLETED_WITH_ERRORS");
    const button = el.querySelector("button");
    expect(button).toBeNull();
  });

  it("shows Watch button for active runs", () => {
    const el = renderWithStatus({ openCreateAlert: vi.fn() }, "EXECUTING");
    const button = el.querySelector("button");
    expect(button).not.toBeNull();
    expect(button?.textContent).toContain("Watch");
  });

  it("hides Watch button for failed runs", () => {
    const el = renderWithStatus({ openCreateAlert: vi.fn() }, "INTERRUPTED");
    const button = el.querySelector("button");
    expect(button).toBeNull();
  });
});
