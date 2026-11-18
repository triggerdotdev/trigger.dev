import type { ServerBuild } from "@remix-run/server-runtime";
import { describe, expect, it } from "vitest";
import { createSdkDefaultAttribution } from "~/services/sdkDefaultAttribution.server";

const routes = {
  root: { id: "root", path: "", module: {} },
  runs: { id: "routes/api.runs.$runId", parentId: "root", path: "api/runs/:runId", module: {} },
  packets: { id: "routes/api.packets.$", parentId: "root", path: "api/packets/*", module: {} },
} satisfies ServerBuild["routes"];

// Catches: concrete IDs, query data, or arbitrary version suffixes leaking into default attribution.
describe("SDK default destination attribution", () => {
  it("uses manifest route IDs and numeric SDK release versions without request data", () => {
    const attribute = createSdkDefaultAttribution(routes);
    const result = attribute(
      new Request("https://example.com/api/runs/run_secret?token=secret", {
        method: "POST",
        headers: { "trigger-version": "4.5.0-beta.secret+private", Authorization: "Bearer secret" },
      })
    );
    expect(result).toEqual({
      attributes: { http_method: "POST", route: "routes/api.runs.$runId" },
      diagnostic: {
        http_method: "POST",
        route: "routes/api.runs.$runId",
        sdk_version: "4.5.0",
        linesHeldBack: 0,
      },
    });
    expect(
      attribute(new Request("https://example.com/api/packets/private/nested")).attributes.route
    ).toBe("routes/api.packets.$");
    expect(attribute(new Request("https://example.com/private")).attributes.route).toBe(
      "unmatched"
    );
    expect(
      attribute(new Request("https://example.com/private", { method: "CUSTOM" })).attributes
        .http_method
    ).toBe("OTHER");
  });

  it("bounds diagnostics globally even when callers vary routes and versions", () => {
    let now = 0;
    const attribute = createSdkDefaultAttribution(routes, () => now);
    for (let i = 0; i < 5; i++) {
      expect(
        attribute(
          new Request(`https://example.com/api/runs/${i}`, {
            headers: { "trigger-version": `4.0.${i}` },
          })
        ).diagnostic
      ).toBeDefined();
    }
    const suppressed = attribute(new Request("https://example.com/api/packets/secret"));
    expect(suppressed.attributes.route).toBe("routes/api.packets.$");
    expect(suppressed.diagnostic).toBeUndefined();
    now = 60_000;
    expect(attribute(new Request("https://example.com/api/runs/next")).diagnostic).toMatchObject({
      sdk_version: "missing",
      linesHeldBack: 1,
    });
    expect(
      attribute(
        new Request("https://example.com/api/runs/next", {
          headers: { "trigger-version": "arbitrary-secret" },
        })
      ).diagnostic?.sdk_version
    ).toBe("invalid");
  });
});
