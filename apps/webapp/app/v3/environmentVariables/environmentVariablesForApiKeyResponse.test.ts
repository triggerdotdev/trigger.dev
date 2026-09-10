import { describe, expect, it } from "vitest";
import { environmentVariablesForApiKeyResponse } from "./environmentVariablesForApiKeyResponse.server";

describe("environmentVariablesForApiKeyResponse", () => {
  it("replaces the resolved root key with the presented API key", () => {
    expect(
      environmentVariablesForApiKeyResponse(
        [
          { key: "USER_VARIABLE", value: "value" },
          { key: "TRIGGER_SECRET_KEY", value: "tr_prod_root" },
          { key: "TRIGGER_API_URL", value: "https://example.com" },
        ],
        "tr_prod_sk_presented"
      )
    ).toEqual({
      USER_VARIABLE: "value",
      TRIGGER_SECRET_KEY: "tr_prod_sk_presented",
      TRIGGER_API_URL: "https://example.com",
    });
  });
});
