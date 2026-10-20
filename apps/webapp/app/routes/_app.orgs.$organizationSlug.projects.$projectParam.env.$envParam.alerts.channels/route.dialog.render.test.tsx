// @vitest-environment jsdom
import { Outlet } from "@remix-run/react";
import { act } from "react";
import { createRoot, hydrateRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import Page from "./route";

vi.mock("~/services/routeBuilders/dashboardBuilder", () => ({
  dashboardLoader: (_options: unknown, handler: unknown) => handler,
  dashboardAction: (_options: unknown, handler: unknown) => handler,
}));
vi.mock("~/hooks/useOrganizations", () => ({ useOrganization: () => ({ slug: "org" }) }));
vi.mock("~/hooks/useProject", () => ({ useProject: () => ({ slug: "proj" }) }));
vi.mock("~/hooks/useEnvironment", () => ({ useEnvironment: () => ({ slug: "prod" }) }));
vi.mock("~/components/alerts/AlertChannelsBody", () => ({
  alertChannelActionSchema: {},
  AlertChannelsBody: ({ alertChannels }: { alertChannels: { name: string }[] }) => (
    <ul>
      {alertChannels.map((c) => (
        <li key={c.name}>{c.name}</li>
      ))}
    </ul>
  ),
}));

const alerts = "/orgs/org/projects/proj/env/prod/alerts";
const channelsData = {
  alertChannels: [{ name: "ops-email" }],
  limits: { used: 1, limit: 10 },
  canWrite: true,
};

function createRouter(url: string) {
  return createMemoryRouter(
    [
      {
        id: "alerts",
        path: alerts,
        element: (
          <div>
            <p>Alerts list</p>
            <Outlet />
          </div>
        ),
        children: [
          { id: "channels", path: "channels", element: <Page />, loader: () => channelsData },
        ],
      },
    ],
    {
      initialEntries: [url],
      hydrationData: { loaderData: { alerts: null, channels: channelsData } },
    }
  );
}

async function renderAt(url: string) {
  const router = createRouter(url);
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => root.render(<RouterProvider router={router} />));
  return { router, container };
}

function pressEscape() {
  const content = document.body.querySelector("[role=dialog]")!;
  content.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
}

describe("alerts channels route", () => {
  it("renders the alerts list with the channels dialog open", async () => {
    const { container } = await renderAt(`${alerts}/channels`);
    expect(container.textContent).toContain("Alerts list");
    const dialog = document.body.querySelector("[role=dialog]");
    expect(dialog?.textContent).toContain("Channels");
    expect(dialog?.textContent).toContain("ops-email");
  });

  it("navigates back to the alerts list keeping its search on Escape", async () => {
    const { router } = await renderAt(`${alerts}/channels?page=2`);
    await act(async () => pressEscape());
    expect(router.state.location.pathname).toBe(alerts);
    expect(router.state.location.search).toBe("?page=2");
  });

  it("fails when the open dialog breaks hydration of a direct load", async () => {
    vi.stubGlobal("document", undefined);
    const html = renderToString(<RouterProvider router={createRouter(`${alerts}/channels`)} />);
    vi.unstubAllGlobals();

    const container = document.createElement("div");
    container.innerHTML = html;
    document.body.appendChild(container);
    const errors: unknown[] = [];
    const router = createRouter(`${alerts}/channels`);
    await act(async () => {
      hydrateRoot(container, <RouterProvider router={router} />, {
        onRecoverableError: (error) => errors.push(error),
      });
    });

    expect(errors).toEqual([]);
    expect(document.body.querySelector("[role=dialog]")?.textContent).toContain("ops-email");
    await act(async () => pressEscape());
    expect(router.state.location.pathname).toBe(alerts);
  });
});
