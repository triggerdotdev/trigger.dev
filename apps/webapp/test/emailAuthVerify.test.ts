import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findOrCreateUser: vi.fn(async ({ email }: { email: string }) => ({
    user: { id: `user_${email}` },
    isNewUser: true,
  })),
}));

vi.mock("~/env.server", () => ({
  env: { MAGIC_LINK_SECRET: "test-magic-link-secret", LOGIN_ORIGIN: "https://cloud.example" },
}));
vi.mock("~/models/user.server", () => ({ findOrCreateUser: mocks.findOrCreateUser }));
vi.mock("~/services/email.server", () => ({ sendMagicLinkEmail: async () => {} }));
vi.mock("~/services/postAuth.server", () => ({ postAuthentication: async () => {} }));
vi.mock("~/services/ssoAutoDiscovery.server", () => ({
  ssoRedirectForEmail: async () => undefined,
  SsoRequiredError: class extends Error {},
}));

import { verifyMagicLink } from "~/services/emailAuth.server";

describe("magic link verify", () => {
  it("creates no user when the link is sent", async () => {
    await expect(
      verifyMagicLink({ email: "someone@example.test", magicLinkVerify: false })
    ).rejects.toThrow();
    expect(mocks.findOrCreateUser).not.toHaveBeenCalled();
  });

  it("creates the user when the link is opened", async () => {
    const result = await verifyMagicLink({ email: "someone@example.test", magicLinkVerify: true });
    expect(mocks.findOrCreateUser).toHaveBeenCalledTimes(1);
    expect(result.userId).toBe("user_someone@example.test");
  });
});
