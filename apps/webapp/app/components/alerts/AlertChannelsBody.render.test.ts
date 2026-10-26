// @vitest-environment jsdom
import { act, createElement, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { OperatingSystemContextProvider } from "~/components/primitives/OperatingSystemProvider";
import { ShortcutsProvider } from "~/components/primitives/ShortcutsProvider";
import { AlertChannelsBody, type AlertChannelRow } from "./AlertChannelsBody";

vi.mock("~/hooks/useOrganizations", () => ({ useOrganization: () => ({ slug: "org" }) }));
vi.mock("~/hooks/useProject", () => ({ useProject: () => ({ slug: "proj" }) }));
vi.mock("~/hooks/useEnvironment", () => ({
  useEnvironment: () => ({ slug: "prod", type: "PRODUCTION" }),
}));
vi.mock("~/hooks/useShowSelfServe", () => ({ useShowSelfServe: () => true }));
vi.mock("~/components/Feedback", () => ({ Feedback: () => null }));
vi.mock("~/components/alerts/AlertsBlankStates", () => ({
  AlertsNoneDev: () => null,
  AlertsNoneDeployed: () => null,
}));
vi.mock("~/components/primitives/Table", async (importOriginal) => {
  const { createElement } = await import("react");
  return {
    ...(await importOriginal<object>()),
    TableCellMenu: ({
      popoverContent,
      className,
    }: {
      popoverContent: ReactNode;
      className?: string;
    }) => createElement("td", { className }, popoverContent),
  };
});

const channel = {
  id: "chan_1",
  name: "Email to ops@example.com",
  type: "EMAIL",
  enabled: true,
  alertTypes: ["TASK_RUN", "DEPLOYMENT_FAILURE"],
  environmentTypes: ["PRODUCTION", "STAGING", "DEVELOPMENT"],
  properties: { type: "EMAIL", email: "ops@example.com" },
} as unknown as AlertChannelRow;

const modal = {
  action: "/orgs/org/projects/proj/env/prod/alerts/channels",
  redirectTo: "/orgs/org/projects/proj/env/prod/alerts/channels",
  fetcher: { Form: "form", state: "idle", data: undefined } as never,
  reload: () => {},
};
const form = { slack: { status: "NOT_CONFIGURED" }, emailAlertsEnabled: true } as never;

function render(
  options: { used?: number; modal?: boolean; channels?: AlertChannelRow[]; url?: string } = {}
) {
  const router = createMemoryRouter(
    [
      {
        path: "/",
        element: createElement(
          OperatingSystemContextProvider,
          { platform: "mac" },
          createElement(
            ShortcutsProvider,
            null,
            createElement(AlertChannelsBody, {
              alertChannels: options.channels ?? [channel],
              limits: { used: options.used ?? 1, limit: 10 },
              canWrite: true,
              ...(options.modal && { modal, form }),
            })
          )
        ),
      },
    ],
    { initialEntries: [options.url ?? "/"] }
  );
  return renderToStaticMarkup(createElement(RouterProvider, { router }));
}

describe("AlertChannelsBody with the alerts flag off", () => {
  it("shows an Add channel button, not the create form, until clicked", () => {
    const under = render({ modal: true, used: 1 });
    expect(under).toContain("Add channel");
    expect(under).not.toContain("create-alert");
    expect(render({ modal: true, used: 10 })).not.toContain("Add channel");
  });

  it("reveals the create form and hides the button after a click", () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    const router = createMemoryRouter([
      {
        path: "/",
        element: createElement(
          OperatingSystemContextProvider,
          { platform: "mac" },
          createElement(
            ShortcutsProvider,
            null,
            createElement(AlertChannelsBody, {
              alertChannels: [channel],
              limits: { used: 1, limit: 10 },
              canWrite: true,
              modal,
              form,
            })
          )
        ),
      },
    ]);
    act(() => root.render(createElement(RouterProvider, { router })));
    const button = () =>
      [...container.querySelectorAll("button")].find((b) => b.textContent === "Add channel");
    expect(container.querySelector("#create-alert")).toBeNull();
    expect(container.querySelector("table")).not.toBeNull();
    expect(container.textContent).toContain("ops@example.com");
    act(() => button()!.click());
    expect(container.querySelector("#create-alert")).not.toBeNull();
    expect(container.textContent).not.toContain("Add channel");
    expect(container.querySelector("table")).toBeNull();
    expect(container.textContent).not.toContain("ops@example.com");
    expect(button()).toBeUndefined();
    act(() => root.unmount());
    container.remove();
  });

  it("opens the create form with no button when there are no channels, including after deleting the last", () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    const show = (alertChannels: AlertChannelRow[]) =>
      act(() =>
        root.render(
          createElement(RouterProvider, {
            router: createMemoryRouter([
              {
                path: "/",
                element: createElement(
                  OperatingSystemContextProvider,
                  { platform: "mac" },
                  createElement(
                    ShortcutsProvider,
                    null,
                    createElement(AlertChannelsBody, {
                      alertChannels,
                      limits: { used: alertChannels.length, limit: 10 },
                      canWrite: true,
                      modal,
                      form,
                    })
                  )
                ),
              },
            ]),
          })
        )
      );
    const button = () =>
      [...container.querySelectorAll("button")].find((b) => b.textContent === "Add channel");
    show([channel]);
    expect(container.querySelector("#create-alert")).toBeNull();
    expect(button()).toBeDefined();
    show([]);
    expect(container.querySelector("#create-alert")).not.toBeNull();
    expect(button()).toBeUndefined();
    act(() => root.unmount());
    container.remove();
  });

  it("opens the form on Slack with a returnTo connect link when add=slack", () => {
    const html = render({ modal: true, url: "/?add=slack" });
    expect(html).toContain('id="create-alert"');
    expect(html).toContain("/alerts/new/connect-to-slack?returnTo=");
    expect(html).toContain(encodeURIComponent("/alerts/channels?add=slack"));
    expect(html).not.toContain("email@youremail.com");
    expect(render({ modal: true })).not.toContain('id="create-alert"');
    expect(render({ modal: true, used: 0, channels: [] })).toContain("email@youremail.com");
  });

  it("disables Delete unless the user can both write and delete the channel", () => {
    const deleteTag = (canWrite: boolean, canDelete: boolean) =>
      render({ modal: true, channels: [{ ...channel, canWrite, canDelete }] }).match(
        /<button[^>]*value="delete"[^>]*>/
      )![0];
    expect(deleteTag(true, false)).toMatch(/\sdisabled(=|\s|>)/);
    expect(deleteTag(false, true)).toMatch(/\sdisabled(=|\s|>)/);
    expect(deleteTag(true, true)).not.toMatch(/\sdisabled(=|\s|>)/);
  });
});
