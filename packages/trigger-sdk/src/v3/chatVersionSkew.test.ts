import { describe, expect, it, vi } from "vitest";

import { resolvePinToFollow, type SessionVersionPin } from "./chatVersionSkew.js";

function readPin(pin: SessionVersionPin | undefined) {
  return vi.fn(async () => pin);
}

describe("resolvePinToFollow", () => {
  it("returns the pin when it names a different deployment", async () => {
    const target = await resolvePinToFollow({
      policy: undefined,
      deployedExternalId: "rel-v1",
      upgradeAlreadyRequested: false,
      readPin: readPin({ externalDeploymentId: "rel-v2" }),
    });

    expect(target).toBe("rel-v2");
  });

  it("returns nothing when the pin already names this deployment", async () => {
    const target = await resolvePinToFollow({
      policy: "follow",
      deployedExternalId: "rel-v2",
      upgradeAlreadyRequested: false,
      readPin: readPin({ externalDeploymentId: "rel-v2" }),
    });

    expect(target).toBeUndefined();
  });

  it("does not read the session when the policy is hold", async () => {
    const read = readPin({ externalDeploymentId: "rel-v2" });

    const target = await resolvePinToFollow({
      policy: "hold",
      deployedExternalId: "rel-v1",
      upgradeAlreadyRequested: false,
      readPin: read,
    });

    expect(target).toBeUndefined();
    expect(read).not.toHaveBeenCalled();
  });

  it("leaves an upgrade the customer already requested alone", async () => {
    const read = readPin({ externalDeploymentId: "rel-v2" });

    const target = await resolvePinToFollow({
      policy: "follow",
      deployedExternalId: "rel-v1",
      upgradeAlreadyRequested: true,
      readPin: read,
    });

    expect(target).toBeUndefined();
    expect(read).not.toHaveBeenCalled();
  });

  it("does nothing without an external id on the deployment", async () => {
    const read = readPin({ externalDeploymentId: "rel-v2" });

    const target = await resolvePinToFollow({
      policy: "follow",
      deployedExternalId: undefined,
      upgradeAlreadyRequested: false,
      readPin: read,
    });

    expect(target).toBeUndefined();
    expect(read).not.toHaveBeenCalled();
  });

  it("does nothing for an unpinned session", async () => {
    const target = await resolvePinToFollow({
      policy: "follow",
      deployedExternalId: "rel-v1",
      upgradeAlreadyRequested: false,
      readPin: readPin({}),
    });

    expect(target).toBeUndefined();
  });

  it("does nothing when the session also sets lockToVersion", async () => {
    const target = await resolvePinToFollow({
      policy: "follow",
      deployedExternalId: "rel-v1",
      upgradeAlreadyRequested: false,
      readPin: readPin({ externalDeploymentId: "rel-v2", lockToVersion: "20260830.7" }),
    });

    expect(target).toBeUndefined();
  });

  it("fails closed when the session read rejects", async () => {
    const target = await resolvePinToFollow({
      policy: "follow",
      deployedExternalId: "rel-v1",
      upgradeAlreadyRequested: false,
      readPin: async () => {
        throw new Error("unreachable");
      },
    });

    expect(target).toBeUndefined();
  });
});
