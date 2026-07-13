import { describe, expect, it } from "vitest";
import { safeEnvironmentLogFields } from "../app/services/safeEnvironmentLog.js";

// AuthenticatedEnvironment carries `apiKey` (and pkApiKey) — these must never
// reach the logger when an environment is logged.
const environment = {
  id: "env_1",
  slug: "prod",
  type: "PRODUCTION",
  projectId: "proj_1",
  organizationId: "org_1",
  apiKey: "tr_prod_SUPERSECRET",
  pkApiKey: "pk_prod_SECRET",
} as any;

describe("safeEnvironmentLogFields", () => {
  it("emits only non-secret identity fields, never the api key", () => {
    const fields = safeEnvironmentLogFields(environment);
    const serialized = JSON.stringify(fields);
    expect(serialized).not.toContain("tr_prod_SUPERSECRET");
    expect(serialized).not.toContain("pk_prod_SECRET");
    expect(serialized).not.toContain("apiKey");
    expect(fields).toEqual({
      id: "env_1",
      slug: "prod",
      type: "PRODUCTION",
      projectId: "proj_1",
      organizationId: "org_1",
    });
  });
});
