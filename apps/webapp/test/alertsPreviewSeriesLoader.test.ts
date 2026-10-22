import { beforeAll, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 30_000 });

const loaded = vi.hoisted(() => ({ calls: [] as unknown[] }));

vi.mock("~/services/routeBuilders/dashboardBuilder", () => ({
  dashboardLoader: (_options: unknown, handler: any) => (args: any) =>
    handler({
      ...args,
      user: { id: "user_1" },
      params: { organizationSlug: "org", projectParam: "proj", envParam: "prod" },
    }),
}));

vi.mock("~/v3/canUseAlertsList.server", () => ({ requireAlertsEnabledOrForbid: async () => {} }));

vi.mock("~/v3/services/alerts/previewSeries.server", async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>();
  return {
    ...original,
    loadPreviewSeries: async (input: unknown) => {
      loaded.calls.push(input);
      throw new Error("Invalid character in alert scope value");
    },
  };
});

let loader: (args: unknown) => Promise<Response>;

beforeAll(async () => {
  const route =
    await import("~/routes/resources.orgs.$organizationSlug.projects.$projectParam.env.$envParam.alerts.preview-series");
  loader = route.loader as unknown as typeof loader;
}, 120_000);

it("400 on a control character in the scope value", async () => {
  const url = new URL("http://localhost/alerts/preview-series");
  url.searchParams.set("capabilityKey", "queue.depth");
  url.searchParams.set("scopeType", "queue");
  url.searchParams.set("scopeValue", "q\u0001");
  const response = await loader({ request: new Request(url), params: {}, context: {} });
  expect(response.status).toBe(400);
  expect(loaded.calls).toHaveLength(0);
});
