import { describe, it, expect } from "vitest";
import type { Event } from "@sentry/remix";
import { tenantContext } from "../app/services/tenantContext.server";
import { addTenantContextToEvent } from "../app/utils/sentryTenantContext.server";

const sample = {
  org: { id: "org_1", slug: "acme" },
  project: { id: "proj_1", ref: "proj_abc" },
  environment: { id: "env_1", slug: "prod", type: "PRODUCTION" as const },
};

describe("addTenantContextToEvent", () => {
  it("returns the event unchanged when no ALS context", () => {
    const event: Event = { message: "hi", tags: { existing: "1" } };
    const out = addTenantContextToEvent(event, {});
    expect(out).toEqual(event);
  });

  it("stamps user + tags when ALS context is set", () => {
    tenantContext.run(sample, () => {
      const event: Event = { message: "boom", tags: { existing: "1" } };
      const out = addTenantContextToEvent(event, {});
      expect(out.user).toEqual({ id: "org_1", username: "acme" });
      expect(out.tags).toMatchObject({
        existing: "1",
        org_id: "org_1",
        org_slug: "acme",
        project_id: "proj_1",
        project_ref: "proj_abc",
        environment_id: "env_1",
        env_slug: "prod",
        env_type: "PRODUCTION",
      });
      expect(out.tags?.impersonating).toBeUndefined();
    });
  });

  it("adds impersonating tag when flag set", () => {
    tenantContext.run({ ...sample, impersonating: true }, () => {
      const out = addTenantContextToEvent({}, {});
      expect(out.tags?.impersonating).toBe("true");
    });
  });

  it("preserves prior event.user fields it does not own", () => {
    tenantContext.run(sample, () => {
      const event: Event = { user: { ip_address: "1.2.3.4" } };
      const out = addTenantContextToEvent(event, {});
      expect(out.user).toEqual({ ip_address: "1.2.3.4", id: "org_1", username: "acme" });
    });
  });
});
