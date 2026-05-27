import { describe, it, expect, vi } from "vitest";
import {
  createTenantContextMiddleware,
  parseTenantPath,
  resolveTenantContextFromPath,
  type PathResolver,
} from "../app/services/tenantContextResolver.server";
import { tenantContext, type TenantContext } from "../app/services/tenantContext.server";

const sampleCtx: TenantContext = {
  orgSlug: "acme",
  projectSlug: "web",
  envSlug: "prod",
};

describe("parseTenantPath", () => {
  it("parses a full env path", () => {
    expect(parseTenantPath("/orgs/acme/projects/web/env/prod")).toEqual({
      orgSlug: "acme",
      projectSlug: "web",
      envSlug: "prod",
    });
  });

  it("parses a path with extra segments after env", () => {
    expect(parseTenantPath("/orgs/acme/projects/web/env/prod/runs/run_1")).toEqual({
      orgSlug: "acme",
      projectSlug: "web",
      envSlug: "prod",
    });
  });

  it("returns undefined for non-orgs paths", () => {
    expect(parseTenantPath("/healthcheck")).toBeUndefined();
    expect(parseTenantPath("/")).toBeUndefined();
    expect(parseTenantPath("/api/v1/tasks")).toBeUndefined();
  });

  it("returns org-only when path has just the org slug", () => {
    expect(parseTenantPath("/orgs/acme")).toEqual({ orgSlug: "acme" });
    expect(parseTenantPath("/orgs/acme/")).toEqual({ orgSlug: "acme" });
    expect(parseTenantPath("/orgs/acme/settings")).toEqual({ orgSlug: "acme" });
  });

  it("returns org + project when env is missing", () => {
    expect(parseTenantPath("/orgs/acme/projects/web")).toEqual({
      orgSlug: "acme",
      projectSlug: "web",
    });
    expect(parseTenantPath("/orgs/acme/projects/web/")).toEqual({
      orgSlug: "acme",
      projectSlug: "web",
    });
  });

  it("does not match if the prefix is wrong", () => {
    expect(parseTenantPath("/foo/orgs/acme/projects/web/env/prod")).toBeUndefined();
  });

  it("handles slugs with hyphens, digits, and mixed case", () => {
    expect(parseTenantPath("/orgs/references-6120/projects/hello-world-bN7m/env/dev")).toEqual({
      orgSlug: "references-6120",
      projectSlug: "hello-world-bN7m",
      envSlug: "dev",
    });
  });
});

describe("resolveTenantContextFromPath", () => {
  it("returns a TenantContext shaped from the parsed slugs", () => {
    expect(resolveTenantContextFromPath("/orgs/acme/projects/web/env/prod")).toEqual({
      orgSlug: "acme",
      projectSlug: "web",
      envSlug: "prod",
    });
  });

  it("returns an empty context when the path does not match (so loaders can still enrich)", () => {
    expect(resolveTenantContextFromPath("/healthcheck")).toEqual({});
  });
});

describe("createTenantContextMiddleware", () => {
  function makeReq(path: string) {
    return { path } as Parameters<ReturnType<typeof createTenantContextMiddleware>>[0];
  }

  it("sets ALS context inside next() when resolver returns a populated context", () => {
    const resolver: PathResolver = vi.fn().mockReturnValue(sampleCtx);
    const middleware = createTenantContextMiddleware(resolver);

    let observed: TenantContext | undefined;
    middleware(makeReq("/orgs/acme/projects/web/env/prod"), {} as never, () => {
      observed = tenantContext.get();
    });

    expect(observed).toEqual(sampleCtx);
    expect(resolver).toHaveBeenCalledWith("/orgs/acme/projects/web/env/prod");
  });

  it("still establishes an empty ALS scope when resolver returns {} (so loaders can enrich)", () => {
    const resolver: PathResolver = vi.fn().mockReturnValue({});
    const middleware = createTenantContextMiddleware(resolver);

    let observed: TenantContext | undefined;
    middleware(makeReq("/healthcheck"), {} as never, () => {
      observed = tenantContext.get();
      tenantContext.enrich({ userId: "usr_1" });
      observed = tenantContext.get();
    });

    expect(observed).toEqual({ userId: "usr_1" });
  });

  it("does not leak ALS context after next() returns", () => {
    const resolver: PathResolver = vi.fn().mockReturnValue(sampleCtx);
    const middleware = createTenantContextMiddleware(resolver);

    middleware(makeReq("/orgs/acme/projects/web/env/prod"), {} as never, () => {});

    expect(tenantContext.get()).toBeUndefined();
  });

  it("isolates concurrent requests", async () => {
    const ctxA: TenantContext = { ...sampleCtx, orgSlug: "a" };
    const ctxB: TenantContext = { ...sampleCtx, orgSlug: "b" };
    const resolver: PathResolver = vi.fn((path: string) => {
      if (path.includes("/a/")) return ctxA;
      if (path.includes("/b/")) return ctxB;
      return {};
    });
    const middleware = createTenantContextMiddleware(resolver);

    const observe = (path: string, delay: number) =>
      new Promise<TenantContext | undefined>((resolve) => {
        middleware(makeReq(path), {} as never, async () => {
          await new Promise((r) => setTimeout(r, delay));
          resolve(tenantContext.get());
        });
      });

    const [a, b] = await Promise.all([
      observe("/orgs/a/projects/x/env/y", 10),
      observe("/orgs/b/projects/x/env/y", 5),
    ]);
    expect(a?.orgSlug).toBe("a");
    expect(b?.orgSlug).toBe("b");
  });
});
