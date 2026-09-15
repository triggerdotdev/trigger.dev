import { validateJWT } from "@trigger.dev/core/v3/jwt";
import { describe, expect, it } from "vitest";
import { publicAccessTokenResponseHeaders } from "~/services/publicAccessTokenResponse.server";

describe("publicAccessTokenResponseHeaders", () => {
  it("returns a server-signed token with the requested resource scopes", async () => {
    const headers = await publicAccessTokenResponseHeaders({
      environment: {
        id: "env_123",
        apiKey: "tr_prod_root_signing_key",
      },
      scopes: ["read:batch:batch_123"],
      expirationTime: "1h",
    });

    expect(JSON.parse(headers["x-trigger-jwt-claims"]!)).toEqual({
      sub: "env_123",
      pub: true,
    });

    const validation = await validateJWT(headers["x-trigger-jwt"]!, "tr_prod_root_signing_key");
    expect(validation.ok).toBe(true);
    if (!validation.ok) return;
    expect(validation.payload).toMatchObject({
      sub: "env_123",
      pub: true,
      scopes: ["read:batch:batch_123"],
    });
  });

  it("uses the parent signing key for branch environments", async () => {
    const headers = await publicAccessTokenResponseHeaders({
      environment: {
        id: "env_branch",
        apiKey: "tr_preview_child_key",
        parentEnvironment: { apiKey: "tr_preview_parent_key" },
      },
      scopes: ["write:waitpoints:waitpoint_123"],
      expirationTime: "24h",
    });

    await expect(
      validateJWT(headers["x-trigger-jwt"]!, "tr_preview_parent_key")
    ).resolves.toMatchObject({ ok: true });
    await expect(
      validateJWT(headers["x-trigger-jwt"]!, "tr_preview_child_key")
    ).resolves.toMatchObject({ ok: false });
  });
});
