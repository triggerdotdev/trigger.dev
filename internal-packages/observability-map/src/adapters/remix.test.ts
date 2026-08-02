import { familyOf, routePathOf } from "./remix.js";

describe("familyOf", () => {
  it("classifies each family from the flat-route filename", () => {
    expect(familyOf("api.v1.runs.$runId.ts")).toBe("api.v1");
    expect(familyOf("api.something.ts")).toBe("api.other");
    expect(familyOf("admin.api.v1.gc.ts")).toBe("admin");
    expect(familyOf("resources.queues.ts")).toBe("resources");
    expect(familyOf("_app.orgs.$slug.ts")).toBe("dashboard");
    expect(familyOf("otel.v1.logs.ts")).toBe("ingest");
    expect(familyOf("@.ts")).toBe("other");
  });

  it("prefers admin over api.v1 for admin-prefixed api routes", () => {
    expect(familyOf("admin.api.v1.environments.$id.ts")).toBe("admin");
  });
});

describe("routePathOf", () => {
  it("turns a flat-route filename into a path", () => {
    expect(routePathOf("api.v1.runs.$runId.ts")).toBe("/api/v1/runs/:runId");
  });

  it("strips a trailing method suffix", () => {
    expect(routePathOf("api.v1.runs.ts")).toBe("/api/v1/runs");
  });
});

// Directory routes: the scanner recurses into Remix directory routes, so `fileName` can be a
// relative path like `_app.orgs.$organizationSlug.projects.$projectParam/route.tsx` rather than a
// flat dot-separated name. The directory name (not `route.tsx`) carries the meaning.
describe("familyOf: directory routes", () => {
  it("classifies a directory route by its directory name, not the flat rules", () => {
    expect(familyOf("_app.orgs.$organizationSlug.projects.$projectParam/route.tsx")).toBe(
      "dashboard"
    );
  });

  it("classifies each family the same whether the route is flat or a directory", () => {
    expect(familyOf("api.v1.runs.$runId/route.tsx")).toBe("api.v1");
    expect(familyOf("admin.api.v1.environments.$id/route.tsx")).toBe("admin");
    expect(familyOf("resources.queues/route.tsx")).toBe("resources");
    expect(familyOf("storybook.callout/route.tsx")).toBe("other");
  });
});

describe("routePathOf: directory routes", () => {
  it("does not emit a literal 'route' segment for a directory route", () => {
    const path = routePathOf("_app.orgs.$organizationSlug.projects.$projectParam/route.tsx");
    expect(path).not.toContain("route");
    expect(path).toBe("/_app/orgs/:organizationSlug/projects/:projectParam");
  });

  it("produces the same path shape for a directory route as its flat equivalent", () => {
    expect(routePathOf("api.v1.runs.$runId/route.tsx")).toBe(routePathOf("api.v1.runs.$runId.ts"));
  });
});
