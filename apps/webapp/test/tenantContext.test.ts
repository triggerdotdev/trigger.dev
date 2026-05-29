import { describe, it, expect } from "vitest";
import { tenantContext, type TenantContext } from "../app/services/tenantContext.server";

const sample: TenantContext = {
  orgSlug: "acme",
  projectSlug: "web",
  envSlug: "prod",
};

describe("tenantContext", () => {
  it("returns undefined outside run()", () => {
    expect(tenantContext.get()).toBeUndefined();
  });

  it("returns the active context inside run()", () => {
    tenantContext.run(sample, () => {
      expect(tenantContext.get()).toEqual(sample);
    });
  });

  it("isolates concurrent async trees", async () => {
    const a: TenantContext = { ...sample, orgSlug: "a" };
    const b: TenantContext = { ...sample, orgSlug: "b" };

    const [got1, got2] = await Promise.all([
      tenantContext.run(a, async () => {
        await new Promise((r) => setTimeout(r, 10));
        return tenantContext.get()?.orgSlug;
      }),
      tenantContext.run(b, async () => {
        await new Promise((r) => setTimeout(r, 5));
        return tenantContext.get()?.orgSlug;
      }),
    ]);
    expect(got1).toBe("a");
    expect(got2).toBe("b");
  });

  it("supports nested run() overriding", () => {
    const inner: TenantContext = { ...sample, orgSlug: "inner" };
    tenantContext.run(sample, () => {
      tenantContext.run(inner, () => {
        expect(tenantContext.get()?.orgSlug).toBe("inner");
      });
      expect(tenantContext.get()?.orgSlug).toBe("acme");
    });
  });

  it("enrich() patches the active context in-place", () => {
    tenantContext.run({ ...sample }, () => {
      tenantContext.enrich({
        userId: "usr_1",
        orgId: "org_1",
        projectId: "proj_1",
        envType: "PRODUCTION",
      });
      expect(tenantContext.get()).toMatchObject({
        orgSlug: "acme",
        projectSlug: "web",
        envSlug: "prod",
        userId: "usr_1",
        orgId: "org_1",
        projectId: "proj_1",
        envType: "PRODUCTION",
      });
    });
  });

  it("enrich() outside run() is a no-op", () => {
    expect(() => tenantContext.enrich({ orgId: "x" })).not.toThrow();
    expect(tenantContext.get()).toBeUndefined();
  });

  it("supports starting from an empty scope and enriching userId only (non-tenant page)", () => {
    tenantContext.run({}, () => {
      tenantContext.enrich({ userId: "usr_1" });
      expect(tenantContext.get()).toEqual({ userId: "usr_1" });
    });
  });

  it("enrich() patches do not bleed across concurrent run() scopes", async () => {
    const a: TenantContext = { ...sample, orgSlug: "a" };
    const b: TenantContext = { ...sample, orgSlug: "b" };
    const [got1, got2] = await Promise.all([
      tenantContext.run(a, async () => {
        await new Promise((r) => setTimeout(r, 5));
        tenantContext.enrich({ orgId: "org_a" });
        await new Promise((r) => setTimeout(r, 5));
        return tenantContext.get();
      }),
      tenantContext.run(b, async () => {
        await new Promise((r) => setTimeout(r, 10));
        tenantContext.enrich({ orgId: "org_b" });
        return tenantContext.get();
      }),
    ]);
    expect(got1?.orgId).toBe("org_a");
    expect(got2?.orgId).toBe("org_b");
  });
});
