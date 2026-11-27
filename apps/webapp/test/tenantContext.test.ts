import { describe, it, expect } from "vitest";
import { organizationContext, type OrganizationContext } from "@internal/run-store";
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

describe("organizationContext", () => {
  const org: OrganizationContext = { organizationId: "org_1", environmentId: "env_1" };

  // Catches: a context that leaks outside run(), or a nested run() that does not override.
  it("run() makes its context current and a nested run() overrides it until it returns", () => {
    expect(organizationContext.get()).toBeUndefined();
    organizationContext.run(org, () => {
      expect(organizationContext.get()).toBe(org);
      const inner: OrganizationContext = { organizationId: "org_2" };
      organizationContext.run(inner, () => expect(organizationContext.get()).toBe(inner));
      expect(organizationContext.get()).toBe(org);
    });
    expect(organizationContext.get()).toBeUndefined();
  });

  // Catches: enrich() or markBornHere() that throws, or creates a context, with no scope in force.
  it("enrich() and markBornHere() patch the context in force and do nothing with none", () => {
    const ctx: OrganizationContext = {};
    organizationContext.run(ctx, () => {
      organizationContext.enrich({ organizationId: "org_1", featureFlags: null });
      organizationContext.markBornHere();
    });
    expect(ctx).toEqual({ organizationId: "org_1", featureFlags: null, bornHere: true });

    expect(() => organizationContext.enrich({ organizationId: "x" })).not.toThrow();
    expect(() => organizationContext.markBornHere()).not.toThrow();
    expect(organizationContext.get()).toBeUndefined();
  });

  // Catches: withEnvironment() replacing a context that already names an environment, or
  // dropping bornHere when it opens a scope.
  it("withEnvironment() keeps a context naming an environment and opens one otherwise", () => {
    organizationContext.run(org, () =>
      organizationContext.withEnvironment("env_other", () =>
        expect(organizationContext.get()).toBe(org)
      )
    );

    const bornHere: OrganizationContext = { organizationId: "org_1", bornHere: true };
    organizationContext.run(bornHere, () =>
      organizationContext.withEnvironment("env_2", () => {
        expect(organizationContext.get()).toEqual({ environmentId: "env_2", bornHere: true });
        expect(organizationContext.get()).not.toBe(bornHere);
      })
    );

    organizationContext.withEnvironment("env_3", () =>
      expect(organizationContext.get()).toEqual({ environmentId: "env_3" })
    );

    organizationContext.withEnvironment(undefined, () =>
      expect(organizationContext.get()).toBeUndefined()
    );
    organizationContext.run(bornHere, () =>
      organizationContext.withEnvironment(undefined, () =>
        expect(organizationContext.get()).toBe(bornHere)
      )
    );
  });

  // Catches: one module-level context shared by concurrent requests.
  it("isolates concurrent async trees", async () => {
    const [got1, got2] = await Promise.all([
      organizationContext.run({ organizationId: "a" }, async () => {
        await new Promise((r) => setTimeout(r, 10));
        return organizationContext.get()?.organizationId;
      }),
      organizationContext.run({ organizationId: "b" }, async () => {
        await new Promise((r) => setTimeout(r, 5));
        return organizationContext.get()?.organizationId;
      }),
    ]);
    expect(got1).toBe("a");
    expect(got2).toBe("b");
  });
});
