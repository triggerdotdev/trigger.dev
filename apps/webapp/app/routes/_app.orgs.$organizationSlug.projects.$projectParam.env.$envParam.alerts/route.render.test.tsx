import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import Page, { loader, redirectChannelsView } from "./route";

const loaderData = vi.hoisted(() => ({ value: undefined as unknown }));

vi.mock("@remix-run/react", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useLoaderData: () => loaderData.value,
}));

vi.mock("~/components/alerts/LegacyAlertChannelsPage", () => ({
  LegacyAlertChannelsPage: () => createElement("div", null, "legacy-channels-page"),
}));

vi.mock("~/components/alerts/AlertChannelsBody", () => ({
  AlertChannelsBody: () => createElement("div", null, "channels-body"),
  alertTypeTitle: (type: string) => type,
}));

vi.mock("~/services/routeBuilders/dashboardBuilder", () => ({
  dashboardLoader: (_options: unknown, handler: unknown) => handler,
  dashboardAction: (_options: unknown, handler: unknown) => handler,
}));

const params = { organizationSlug: "org", projectParam: "proj", envParam: "prod" };
const base = "http://localhost/orgs/org/projects/proj/env/prod/alerts";

describe("alerts list ?view=channels", () => {
  it("fails when the redirect to the channels page is dropped", () => {
    const response = redirectChannelsView(new Request(`${base}?view=channels`), params);
    expect(response?.status).toBe(302);
    expect(response?.headers.get("Location")).toBe(
      "/orgs/org/projects/proj/env/prod/alerts/channels"
    );
  });

  it("fails when ?modal=channels is not redirected to the channels page", () => {
    const response = redirectChannelsView(new Request(`${base}?modal=channels&page=2`), params);
    expect(response?.headers.get("Location")).toBe(
      "/orgs/org/projects/proj/env/prod/alerts/channels?page=2"
    );
  });

  it("does not redirect the plain list", () => {
    expect(redirectChannelsView(new Request(base), params)).toBeNull();
  });

  it("fails when the loader stops redirecting ?view=channels", async () => {
    const response = (await (loader as any)({
      params,
      request: new Request(`${base}?view=channels`),
      user: { id: "u1" },
      ability: { can: () => true },
    })) as Response;
    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toMatch(/\/alerts\/channels$/);
  });
});

describe("alerts page with the flag off", () => {
  it("renders the legacy channels page and not the modal body", () => {
    loaderData.value = {
      mode: "legacy",
      alertChannels: [],
      limits: { used: 0, limit: 10 },
      canWrite: true,
    };
    const html = renderToStaticMarkup(createElement(Page));
    expect(html).toContain("legacy-channels-page");
    expect(html).not.toContain("channels-body");
  });
});
