// The task and agent pages decide the Upgrade sessions button from the session their loader
// already authenticated, instead of authenticating it a second time.

import { describe, expect, it, vi } from "vitest";

vi.mock("~/services/rbac.server", () => ({ rbac: {} }));
vi.mock("~/env.server", () => ({ env: { ADMIN_DASHBOARD_ENABLED: false } }));

import { canWriteDeployments } from "~/services/canWriteDeployments.server";

function auth(can: (action: string, resource: { type: string }) => boolean) {
  return { ok: true, ability: { can, canSuper: () => false } } as never;
}

describe("canWriteDeployments", () => {
  it("asks the ability for write on deployments", () => {
    const asked: unknown[] = [];
    const result = canWriteDeployments(
      auth((action, resource) => {
        asked.push([action, resource.type]);
        return true;
      })
    );
    expect(result).toBe(true);
    expect(asked).toEqual([["write", "deployments"]]);
  });

  it("is false when the role can't write deployments", () => {
    expect(canWriteDeployments(auth(() => false))).toBe(false);
  });

  // Catches: hiding the button when the session can't be resolved, unlike the Deployments page.
  it("is permissive when the session can't be resolved, like the Deployments page", () => {
    expect(canWriteDeployments({ ok: false } as never)).toBe(true);
  });
});
