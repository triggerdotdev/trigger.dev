import { describe, it, expect, vi } from "vitest";
import {
  createTenantContextMiddleware,
  parseTenantPath,
  type PathResolver,
} from "../app/services/tenantContextResolver.server";
import { tenantContext, type TenantContext } from "../app/services/tenantContext.server";

const sampleCtx: TenantContext = {
  org: { id: "org_1", slug: "acme" },
  project: { id: "proj_1", ref: "proj_abc" },
  environment: { id: "env_1", slug: "prod", type: "PRODUCTION" },
};

describe("parseTenantPath", () => {
  it("parses a full env path", () => {
    expect(parseTenantPath("/orgs/acme/projects/web/env/prod")).toEqual({
      orgSlug: "acme",
      projectParam: "web",
      envParam: "prod",
    });
  });

  it("parses a path with extra segments after env", () => {
    expect(parseTenantPath("/orgs/acme/projects/web/env/prod/runs/run_1")).toEqual({
      orgSlug: "acme",
      projectParam: "web",
      envParam: "prod",
    });
  });

  it("parses a path with a query-style suffix already stripped", () => {
    expect(parseTenantPath("/orgs/acme/projects/web/env/prod")).toEqual({
      orgSlug: "acme",
      projectParam: "web",
      envParam: "prod",
    });
  });

  it("returns undefined for non-orgs paths", () => {
    expect(parseTenantPath("/healthcheck")).toBeUndefined();
    expect(parseTenantPath("/")).toBeUndefined();
    expect(parseTenantPath("/api/v1/tasks")).toBeUndefined();
  });

  it("returns undefined when org-only (no project)", () => {
    expect(parseTenantPath("/orgs/acme")).toBeUndefined();
    expect(parseTenantPath("/orgs/acme/")).toBeUndefined();
  });

  it("returns undefined when project but no env", () => {
    expect(parseTenantPath("/orgs/acme/projects/web")).toBeUndefined();
    expect(parseTenantPath("/orgs/acme/projects/web/")).toBeUndefined();
    expect(parseTenantPath("/orgs/acme/projects/web/env")).toBeUndefined();
    expect(parseTenantPath("/orgs/acme/projects/web/env/")).toBeUndefined();
  });

  it("does not match if the prefix is wrong", () => {
    expect(parseTenantPath("/foo/orgs/acme/projects/web/env/prod")).toBeUndefined();
  });

  it("handles slugs with hyphens, digits, and mixed case", () => {
    expect(parseTenantPath("/orgs/references-6120/projects/hello-world-bN7m/env/dev")).toEqual({
      orgSlug: "references-6120",
      projectParam: "hello-world-bN7m",
      envParam: "dev",
    });
  });
});

describe("createTenantContextMiddleware", () => {
  function makeReq(path: string) {
    return { path } as Parameters<ReturnType<typeof createTenantContextMiddleware>>[0];
  }

  it("sets ALS context inside next() when resolver returns a context", async () => {
    const resolver: PathResolver = vi.fn().mockResolvedValue(sampleCtx);
    const middleware = createTenantContextMiddleware(resolver);

    let observed: TenantContext | undefined;
    await new Promise<void>((resolve) => {
      middleware(makeReq("/orgs/acme/projects/web/env/prod"), {} as never, () => {
        observed = tenantContext.get();
        resolve();
      });
    });

    expect(observed).toEqual(sampleCtx);
    expect(resolver).toHaveBeenCalledWith("/orgs/acme/projects/web/env/prod");
  });

  it("calls next() without ALS when resolver returns undefined", async () => {
    const resolver: PathResolver = vi.fn().mockResolvedValue(undefined);
    const middleware = createTenantContextMiddleware(resolver);

    let observed: TenantContext | undefined = sampleCtx;
    await new Promise<void>((resolve) => {
      middleware(makeReq("/healthcheck"), {} as never, () => {
        observed = tenantContext.get();
        resolve();
      });
    });

    expect(observed).toBeUndefined();
  });

  it("does not leak ALS context after next() returns", async () => {
    const resolver: PathResolver = vi.fn().mockResolvedValue(sampleCtx);
    const middleware = createTenantContextMiddleware(resolver);

    await new Promise<void>((resolve) => {
      middleware(makeReq("/orgs/acme/projects/web/env/prod"), {} as never, () => resolve());
    });

    expect(tenantContext.get()).toBeUndefined();
  });

  it("isolates concurrent requests", async () => {
    const ctxA: TenantContext = { ...sampleCtx, org: { id: "a", slug: "a" } };
    const ctxB: TenantContext = { ...sampleCtx, org: { id: "b", slug: "b" } };
    const resolver: PathResolver = vi.fn(async (path: string) => {
      if (path.includes("/a")) return ctxA;
      if (path.includes("/b")) return ctxB;
      return undefined;
    });
    const middleware = createTenantContextMiddleware(resolver);

    const observe = (path: string, delay: number) =>
      new Promise<TenantContext | undefined>((resolve) => {
        middleware(makeReq(path), {} as never, async () => {
          await new Promise((r) => setTimeout(r, delay));
          resolve(tenantContext.get());
        });
      });

    const [a, b] = await Promise.all([observe("/orgs/a/projects/x/env/y", 10), observe("/orgs/b/projects/x/env/y", 5)]);
    expect(a?.org.id).toBe("a");
    expect(b?.org.id).toBe("b");
  });

  it("calls next() without ALS when the resolver throws", async () => {
    const resolver: PathResolver = vi.fn().mockRejectedValue(new Error("boom"));
    const middleware = createTenantContextMiddleware(resolver);

    // The middleware itself doesn't catch resolver errors — production
    // `resolveTenantContextFromPath` swallows them. We assert that behavior:
    // a throwing resolver propagates, so the production resolver MUST catch.
    await expect(
      new Promise<void>((resolve, reject) => {
        middleware(makeReq("/orgs/acme/projects/web/env/prod"), {} as never, () => resolve()).catch(
          reject
        );
      })
    ).rejects.toThrow("boom");
  });
});
