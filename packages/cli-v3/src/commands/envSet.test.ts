import { describe, expect, it } from "vitest";
import { buildEnvSetImportBody } from "./envSet.js";

describe("buildEnvSetImportBody", () => {
  it("omits isSecret unless --secret is set, so an existing secret is not demoted", () => {
    expect(buildEnvSetImportBody("STRIPE_KEY", "sk_live_abc", false)).toEqual({
      variables: { STRIPE_KEY: "sk_live_abc" },
      override: true,
    });
    expect(buildEnvSetImportBody("STRIPE_KEY", "sk_live_abc", false)).not.toHaveProperty(
      "isSecret"
    );
  });

  it("sends isSecret: true when --secret is set", () => {
    expect(buildEnvSetImportBody("STRIPE_KEY", "sk_live_abc", true)).toEqual({
      variables: { STRIPE_KEY: "sk_live_abc" },
      override: true,
      isSecret: true,
    });
  });
});
