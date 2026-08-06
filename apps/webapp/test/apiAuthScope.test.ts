import { describe, expect, it, vi } from "vitest";
import { authenticateApiKeyWithScope } from "~/services/apiAuth.server";

const authorizeBearer = vi.fn();

describe("authenticateApiKeyWithScope", () => {
  it("returns 401 without a bearer credential", async () => {
    const result = await authenticateApiKeyWithScope(
      new Request("https://example.com"),
      { action: "read", resource: { type: "envvars" } },
      authorizeBearer
    );

    expect(result).toEqual({
      ok: false,
      status: 401,
      error: "Invalid or Missing API key",
    });
    expect(authorizeBearer).not.toHaveBeenCalled();
  });

  it.each([
    { status: 401 as const, error: "Invalid API key" },
    { status: 403 as const, error: "Unauthorized" },
  ])("preserves controller $status failures", async (failure) => {
    authorizeBearer.mockResolvedValueOnce({ ok: false, ...failure });
    const request = new Request("https://example.com", {
      headers: { Authorization: "Bearer tr_test_key" },
    });

    await expect(
      authenticateApiKeyWithScope(
        request,
        { action: "write", resource: { type: "deployments" } },
        authorizeBearer
      )
    ).resolves.toEqual({ ok: false, ...failure });
  });

  it("bridges controller success into the legacy private authentication shape", async () => {
    const environment = { id: "env_123" };
    const ability = { can: vi.fn(() => true), canSuper: vi.fn(() => true) };
    authorizeBearer.mockResolvedValueOnce({
      ok: true,
      environment,
      ability,
      subject: { type: "apiKey", apiKeyId: "key_123" },
    });
    const request = new Request("https://example.com", {
      headers: { Authorization: "Bearer tr_test_key" },
    });

    const result = await authenticateApiKeyWithScope(
      request,
      { action: "read", resource: { type: "envvars" }, allowJWT: true },
      authorizeBearer
    );

    expect(authorizeBearer).toHaveBeenCalledWith(
      request,
      { action: "read", resource: { type: "envvars" } },
      { allowJWT: true }
    );
    expect(result).toEqual({
      ok: true,
      authentication: {
        ok: true,
        apiKey: "tr_test_key",
        type: "PRIVATE",
        environment,
        ability,
      },
    });
  });

  it("returns authorization failures from the controller", async () => {
    const ability = { can: vi.fn(() => false), canSuper: vi.fn(() => false) };
    authorizeBearer.mockResolvedValueOnce({
      ok: false,
      status: 403,
      error: "Unauthorized",
    });
    const request = new Request("https://example.com", {
      headers: { Authorization: "Bearer tr_prod_sk_test" },
    });

    await expect(
      authenticateApiKeyWithScope(
        request,
        { action: "write", resource: { type: "deployments" } },
        authorizeBearer
      )
    ).resolves.toEqual({ ok: false, status: 403, error: "Unauthorized" });
    expect(ability.can).not.toHaveBeenCalled();
  });
});
