import type { DirectorySyncEffect } from "@trigger.dev/plugins";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("~/db.server", () => ({ prisma: {}, $replica: {} }));
vi.mock("~/services/platformNotifications.server", () => ({
  createPlatformNotification: vi.fn(),
}));

const getSsoEntitlement = vi.fn();
vi.mock("~/services/platform.v3.server", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, getSsoEntitlement: (orgId: string) => getSsoEntitlement(orgId) };
});

const setUserRole = vi.fn();
vi.mock("~/services/rbac.server", () => ({
  rbac: { setUserRole: (a: unknown) => setUserRole(a) },
}));

const ensureOrgMember = vi.fn();
const ensureUserForDirectory = vi.fn();
const removeOrgMemberForDirectory = vi.fn();
vi.mock("~/models/orgMember.server", () => ({
  ensureOrgMember: (a: unknown) => ensureOrgMember(a),
  ensureUserForDirectory: (a: unknown) => ensureUserForDirectory(a),
  removeOrgMemberForDirectory: (a: unknown) => removeOrgMemberForDirectory(a),
}));

import { applyDirectorySyncEffects } from "~/services/directorySyncEffects.server";

const ENTITLED_ORG = "org_entitled";
const UNENTITLED_ORG = "org_unentitled";

function provision(organizationId: string, email = "someone@acme.com"): DirectorySyncEffect {
  return {
    kind: "provision",
    userId: "user_1",
    email,
    firstName: null,
    lastName: null,
    organizationId,
    roleId: null,
  };
}

function deprovision(organizationId: string): DirectorySyncEffect {
  return { kind: "deprovision", userId: "user_1", organizationId };
}

describe("applyDirectorySyncEffects — SSO entitlement gate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ensureOrgMember.mockResolvedValue({
      created: true,
      orgMemberId: "member_1",
      devEnvironmentsQueued: true,
    });
    removeOrgMemberForDirectory.mockResolvedValue({ removed: true });
    setUserRole.mockResolvedValue({ ok: true });
  });

  it("applies effects for an entitled org", async () => {
    getSsoEntitlement.mockResolvedValue("entitled");

    await applyDirectorySyncEffects([provision(ENTITLED_ORG)]);

    expect(ensureOrgMember).toHaveBeenCalledTimes(1);
    expect(ensureOrgMember).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: ENTITLED_ORG, source: "directory_sync" })
    );
  });

  it("skips provisioning for an org without the entitlement", async () => {
    getSsoEntitlement.mockResolvedValue("not_entitled");

    await applyDirectorySyncEffects([provision(UNENTITLED_ORG)]);

    expect(ensureOrgMember).not.toHaveBeenCalled();
    expect(ensureUserForDirectory).not.toHaveBeenCalled();
  });

  it("skips deprovisioning too, so revocation cannot remove members", async () => {
    getSsoEntitlement.mockResolvedValue("not_entitled");

    await applyDirectorySyncEffects([deprovision(UNENTITLED_ORG)]);

    expect(removeOrgMemberForDirectory).not.toHaveBeenCalled();
  });

  it("throws on an unreadable entitlement so the worker retries", async () => {
    getSsoEntitlement.mockResolvedValue("unknown");

    await expect(applyDirectorySyncEffects([provision(ENTITLED_ORG)])).rejects.toThrow(
      /could not read the SSO entitlement/
    );

    expect(ensureOrgMember).not.toHaveBeenCalled();
  });

  it("marks the retry as a warning rather than a pageable error", async () => {
    getSsoEntitlement.mockResolvedValue("unknown");

    await applyDirectorySyncEffects([provision(ENTITLED_ORG)]).then(
      () => expect.unreachable("should have thrown"),
      (error) => expect(error).toMatchObject({ logLevel: "warn" })
    );
  });

  it("resolves the entitlement once per org across a batch", async () => {
    getSsoEntitlement.mockResolvedValue("entitled");

    await applyDirectorySyncEffects([
      provision(ENTITLED_ORG, "a@acme.com"),
      provision(ENTITLED_ORG, "b@acme.com"),
      provision(ENTITLED_ORG, "c@acme.com"),
    ]);

    expect(getSsoEntitlement).toHaveBeenCalledTimes(1);
    expect(ensureOrgMember).toHaveBeenCalledTimes(3);
  });

  it("gates per org, so one unentitled org does not block another", async () => {
    getSsoEntitlement.mockImplementation(async (orgId: string) =>
      orgId === ENTITLED_ORG ? "entitled" : "not_entitled"
    );

    await applyDirectorySyncEffects([provision(UNENTITLED_ORG), provision(ENTITLED_ORG)]);

    expect(ensureOrgMember).toHaveBeenCalledTimes(1);
    expect(ensureOrgMember).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: ENTITLED_ORG })
    );
  });

  it("applies every effect in the batch and reports the unqueued members", async () => {
    getSsoEntitlement.mockResolvedValue("entitled");
    ensureOrgMember
      .mockResolvedValueOnce({
        created: true,
        orgMemberId: "member_1",
        devEnvironmentsQueued: false,
      })
      .mockResolvedValueOnce({
        created: true,
        orgMemberId: "member_2",
        devEnvironmentsQueued: true,
      });

    const { unqueuedUserIds } = await applyDirectorySyncEffects([
      provision(ENTITLED_ORG, "a@acme.com"),
      provision(ENTITLED_ORG, "b@acme.com"),
      deprovision(ENTITLED_ORG),
    ]);

    expect(unqueuedUserIds).toEqual(["user_1"]);
    expect(ensureOrgMember).toHaveBeenCalledTimes(2);
    expect(removeOrgMemberForDirectory).toHaveBeenCalledTimes(1);
  });

  it("applies the directory role even when provisioning could not be queued", async () => {
    getSsoEntitlement.mockResolvedValue("entitled");
    ensureOrgMember.mockResolvedValue({
      created: false,
      orgMemberId: "member_1",
      devEnvironmentsQueued: false,
    });

    const effect = { ...provision(ENTITLED_ORG), roleId: "role_restricted" };

    const { unqueuedUserIds } = await applyDirectorySyncEffects([effect]);

    expect(unqueuedUserIds).toEqual(["user_1"]);
    expect(setUserRole).toHaveBeenCalledWith(
      expect.objectContaining({ roleId: "role_restricted", organizationId: ENTITLED_ORG })
    );
  });

  it("reports nothing to retry when every provision was queued", async () => {
    getSsoEntitlement.mockResolvedValue("entitled");

    const { unqueuedUserIds } = await applyDirectorySyncEffects([provision(ENTITLED_ORG)]);

    expect(unqueuedUserIds).toEqual([]);
  });
});
