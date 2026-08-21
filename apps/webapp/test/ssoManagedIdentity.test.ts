import type { OrgSsoStatus } from "@trigger.dev/plugins";
import { describe, expect, it } from "vitest";
import { idpOwnsEmailDomain } from "~/services/ssoManagedIdentity.server";

function status(overrides: Partial<OrgSsoStatus> = {}): OrgSsoStatus {
  return {
    hasIdpOrg: true,
    enforced: true,
    jitProvisioningEnabled: false,
    jitDefaultRoleId: null,
    idpOrgId: "idp_123",
    primaryConnectionId: "conn_123",
    domains: [
      { domain: "acme.com", verified: true, state: "verified", verificationFailedReason: null },
    ],
    connections: [{ id: "conn_123", name: "Okta", connectionType: "OktaSAML", state: "active" }],
    ...overrides,
  };
}

describe("idpOwnsEmailDomain", () => {
  it("claims a member on a verified domain of an enforcing org", () => {
    expect(idpOwnsEmailDomain(status(), "acme.com")).toBe(true);
  });

  it("leaves a contractor on another domain alone", () => {
    expect(idpOwnsEmailDomain(status(), "freelance.io")).toBe(false);
  });

  it("leaves everyone alone until SSO is enforced", () => {
    expect(idpOwnsEmailDomain(status({ enforced: false }), "acme.com")).toBe(false);
  });

  it("ignores a domain that hasn't been verified", () => {
    expect(
      idpOwnsEmailDomain(
        status({
          domains: [
            {
              domain: "acme.com",
              verified: false,
              state: "pending",
              verificationFailedReason: null,
            },
          ],
        }),
        "acme.com"
      )
    ).toBe(false);
  });

  it("ignores an org with no live connection", () => {
    expect(
      idpOwnsEmailDomain(
        status({
          connections: [
            { id: "conn_123", name: "Okta", connectionType: "OktaSAML", state: "inactive" },
          ],
        }),
        "acme.com"
      )
    ).toBe(false);
  });

  it("matches domains case-insensitively", () => {
    expect(
      idpOwnsEmailDomain(
        status({
          domains: [
            {
              domain: "ACME.com",
              verified: true,
              state: "verified",
              verificationFailedReason: null,
            },
          ],
        }),
        "acme.com"
      )
    ).toBe(true);
  });

  it("does not treat a subdomain as the verified domain", () => {
    expect(idpOwnsEmailDomain(status(), "mail.acme.com")).toBe(false);
  });
});
