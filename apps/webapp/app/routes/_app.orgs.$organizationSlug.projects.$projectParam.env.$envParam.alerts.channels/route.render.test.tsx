import { describe, expect, it, vi } from "vitest";
import { action, resolveChannelsRedirect } from "./route";

vi.mock("~/services/routeBuilders/dashboardBuilder", () => ({
  dashboardLoader: (_options: unknown, handler: unknown) => handler,
  dashboardAction: (options: any, handler: any) => async (args: any) => {
    if (!args.ability.can(options.authorization.action, options.authorization.resource)) {
      throw new Response(null, { status: 403 });
    }
    return handler(args);
  },
}));

describe("channels action", () => {
  it("fails when the write guard is dropped", async () => {
    const response = await action({
      ability: { can: (verb: string) => verb === "read" },
      request: new Request("http://localhost/alerts/channels", { method: "POST" }),
      params: {},
      user: { id: "u1" },
    } as any).catch((e: Response) => e);
    expect(response.status).toBe(403);
  });
});

describe("channels redirect", () => {
  const resolve = (value: string | null) =>
    resolveChannelsRedirect(value, { slug: "org" }, { slug: "proj" }, { slug: "prod" });
  const base = "/orgs/org/projects/proj/env/prod/alerts";

  it("keeps a redirect inside the same project alerts", () => {
    expect(resolve(`${base}/channels?page=2`)).toBe(`${base}/channels?page=2`);
  });

  it("fails when a foreign path is honoured", () => {
    for (const bad of [
      "/orgs/other/projects/proj/env/prod/alerts",
      "https://evil.example/",
      `${base}x`,
      `${"x".repeat(base.length)}/y`,
      null,
    ]) {
      expect(resolve(bad)).toBe(`${base}/channels`);
    }
  });
});
