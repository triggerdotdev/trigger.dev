import { describe, it, expect } from "vitest";
import { tenantContext, type TenantContext } from "../app/services/tenantContext.server";

const sample: TenantContext = {
  org: { id: "org_1", slug: "acme" },
  project: { id: "proj_1", ref: "proj_abc" },
  environment: { id: "env_1", slug: "prod", type: "PRODUCTION" },
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
    const a: TenantContext = { ...sample, org: { id: "org_a", slug: "a" } };
    const b: TenantContext = { ...sample, org: { id: "org_b", slug: "b" } };

    const [got1, got2] = await Promise.all([
      tenantContext.run(a, async () => {
        await new Promise((r) => setTimeout(r, 10));
        return tenantContext.get()?.org.id;
      }),
      tenantContext.run(b, async () => {
        await new Promise((r) => setTimeout(r, 5));
        return tenantContext.get()?.org.id;
      }),
    ]);
    expect(got1).toBe("org_a");
    expect(got2).toBe("org_b");
  });

  it("supports nested run() overriding", () => {
    const inner: TenantContext = { ...sample, org: { id: "org_inner", slug: "inner" } };
    tenantContext.run(sample, () => {
      tenantContext.run(inner, () => {
        expect(tenantContext.get()?.org.id).toBe("org_inner");
      });
      expect(tenantContext.get()?.org.id).toBe("org_1");
    });
  });
});
