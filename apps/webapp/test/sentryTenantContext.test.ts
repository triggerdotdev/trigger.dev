import { describe, it, expect } from "vitest";
import type { Event } from "@sentry/remix";
import { tenantContext } from "../app/services/tenantContext.server";
import { addTenantContextToEvent } from "../app/utils/sentryTenantContext.server";

const slugOnly = {
  orgSlug: "acme",
  projectSlug: "web",
  envSlug: "prod",
};

const enrichedWithUser = {
  ...slugOnly,
  userId: "usr_42",
  orgId: "org_1",
  projectId: "proj_1",
  projectRef: "proj_abc",
  envId: "env_1",
  envType: "PRODUCTION" as const,
};

describe("addTenantContextToEvent", () => {
  it("returns the event unchanged when no ALS context", () => {
    const event: Event = { message: "hi", tags: { existing: "1" } };
    const out = addTenantContextToEvent(event, {});
    expect(out).toEqual(event);
  });

  it("stamps only userId when the scope holds just a user (non-tenant page)", () => {
    tenantContext.run({ userId: "usr_42" }, () => {
      const event: Event = { message: "boom", tags: { existing: "1" } };
      const out = addTenantContextToEvent(event, {});
      expect(out.user).toEqual({ id: "usr_42" });
      expect(out.tags).toEqual({ existing: "1" });
    });
  });

  it("stamps slug tags and no user.id when only slugs are set", () => {
    tenantContext.run(slugOnly, () => {
      const event: Event = { message: "boom", tags: { existing: "1" } };
      const out = addTenantContextToEvent(event, {});
      expect(out.user).toBeUndefined();
      expect(out.tags).toMatchObject({
        existing: "1",
        org_slug: "acme",
        project_slug: "web",
        env_slug: "prod",
      });
      expect(out.tags?.org_id).toBeUndefined();
      expect(out.tags?.env_type).toBeUndefined();
    });
  });

  it("stamps user.id + full tag set when fully enriched", () => {
    tenantContext.run(enrichedWithUser, () => {
      const out = addTenantContextToEvent({}, {});
      expect(out.user).toEqual({ id: "usr_42" });
      expect(out.tags).toMatchObject({
        org_slug: "acme",
        project_slug: "web",
        env_slug: "prod",
        org_id: "org_1",
        project_id: "proj_1",
        project_ref: "proj_abc",
        environment_id: "env_1",
        env_type: "PRODUCTION",
      });
    });
  });

  it("emits no slug/ID tags when scope is empty", () => {
    tenantContext.run({}, () => {
      const out = addTenantContextToEvent({ tags: { existing: "1" } }, {});
      expect(out.tags).toEqual({ existing: "1" });
      expect(out.user).toBeUndefined();
    });
  });

  it("adds impersonating tag when flag set", () => {
    tenantContext.run({ ...slugOnly, impersonating: true }, () => {
      const out = addTenantContextToEvent({}, {});
      expect(out.tags?.impersonating).toBe("true");
    });
  });

  it("preserves prior event.user fields it does not own", () => {
    tenantContext.run(enrichedWithUser, () => {
      const event: Event = { user: { ip_address: "1.2.3.4" } };
      const out = addTenantContextToEvent(event, {});
      expect(out.user).toEqual({ ip_address: "1.2.3.4", id: "usr_42" });
    });
  });
});
