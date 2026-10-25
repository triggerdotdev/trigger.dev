import { SDKError } from "@vercel/sdk/models/sdkerror.js";
import { describe, expect, it } from "vitest";
import { toVercelApiError } from "~/v3/vercel/vercelApiError";

function vercelHttpError(status: number, body: unknown) {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return new SDKError("API error occurred", {
    response: new Response(text, {
      status,
      headers: { "content-type": "application/json" },
    }),
    request: new Request("https://api.vercel.com/v1/integrations/configuration/icfg_1"),
    body: text,
  });
}

const disabledBody = {
  error: {
    code: "integration_configuration_disabled",
    message: "The integration configuration is disabled.",
  },
};

describe("toVercelApiError", () => {
  it("treats a disabled installation as disabled, not a revoked token", () => {
    expect(toVercelApiError(vercelHttpError(403, disabledBody))).toMatchObject({
      reason: "disabled",
      authInvalid: false,
    });
  });

  it("reads the disabled code from a plain error with a body", () => {
    const error = Object.assign(new Error("Failed to fetch Vercel shared environment variables"), {
      status: 403,
      body: JSON.stringify({ error: { code: "integration_configuration_disabled" } }),
    });

    expect(toVercelApiError(error)).toMatchObject({ reason: "disabled", authInvalid: false });
  });

  it("treats a 403 without the disabled code as revoked", () => {
    expect(
      toVercelApiError(vercelHttpError(403, { error: { code: "forbidden", message: "nope" } }))
    ).toMatchObject({ reason: "revoked", authInvalid: true });
    expect(toVercelApiError(vercelHttpError(403, "not json"))).toMatchObject({
      reason: "revoked",
      authInvalid: true,
    });
  });

  it("treats a 401 as revoked", () => {
    expect(
      toVercelApiError(vercelHttpError(401, { error: { code: "unauthorized" } }))
    ).toMatchObject({ reason: "revoked", authInvalid: true });
  });

  it("treats a 500 as other", () => {
    expect(toVercelApiError(vercelHttpError(500, { error: { code: "internal" } }))).toMatchObject({
      reason: "other",
      authInvalid: false,
    });
  });

  it("keeps the reason of an existing VercelApiError", () => {
    const disabled = toVercelApiError(vercelHttpError(403, disabledBody));
    expect(toVercelApiError(disabled)).toMatchObject({ reason: "disabled", authInvalid: false });

    const revoked = toVercelApiError(vercelHttpError(401, {}));
    expect(toVercelApiError(revoked)).toMatchObject({ reason: "revoked", authInvalid: true });
  });
});
