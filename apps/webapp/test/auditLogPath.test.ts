import { describe, expect, it } from "vitest";
import {
  parseCredentialReference,
  rootKeyReference,
} from "~/presenters/v3/auditLogCredentials.server";
import { organizationAuditLogCredentialPath, organizationAuditLogPath } from "~/utils/pathBuilder";

const organization = { slug: "acme" };

describe("organizationAuditLogPath", () => {
  it("is the page itself without filters", () => {
    expect(organizationAuditLogPath(organization)).toBe("/orgs/acme/settings/audit-log");
    expect(organizationAuditLogPath(organization, {})).toBe("/orgs/acme/settings/audit-log");
  });

  it("puts each filter in the query and leaves out empty ones", () => {
    const path = organizationAuditLogPath(organization, {
      category: "envvars",
      project: "proj_1",
      environment: "env_1",
      credential: undefined,
      actor: "",
    });
    const url = new URL(path, "https://example.com");
    expect(url.pathname).toBe("/orgs/acme/settings/audit-log");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      category: "envvars",
      project: "proj_1",
      environment: "env_1",
    });
  });

  it("carries credential references the audit log parses back", () => {
    const root = rootKeyReference("env_1", "tr_prod_••••••••ab12");
    for (const credential of [root, "key:apikey_1"]) {
      const url = new URL(
        organizationAuditLogPath(organization, { category: "credentials", credential }),
        "https://example.com"
      );
      expect(url.searchParams.get("credential")).toBe(credential);
      expect(
        parseCredentialReference(url.searchParams.get("credential") ?? undefined)
      ).not.toBeNull();
    }
    expect(parseCredentialReference(root)).toEqual({ kind: "root", id: "env_1", last4: "ab12" });
  });

  it("filters a key's activity by the key alone, in every category", () => {
    const url = new URL(
      organizationAuditLogCredentialPath(organization, "key:apikey_1"),
      "https://example.com"
    );
    expect(url.pathname).toBe("/orgs/acme/settings/audit-log");
    expect(Object.fromEntries(url.searchParams)).toEqual({ credential: "key:apikey_1" });
  });
});
