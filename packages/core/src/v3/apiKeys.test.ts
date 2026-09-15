import { describe, expect, it } from "vitest";
import { isAdditionalApiKey } from "./apiKeys.js";

describe("isAdditionalApiKey", () => {
  it.each(["dev", "stg", "prod", "preview"])("recognizes %s additional keys", (environment) => {
    expect(isAdditionalApiKey(`tr_${environment}_sk_0123456789abcdefghijklmn`)).toBe(true);
  });

  it.each([
    "tr_prod_0123456789abcdefghijklmn",
    "tr_prod_sk_too-short",
    "tr_prod_sk_0123456789abcdefghijklmn_extra",
    "tr_test_sk_0123456789abcdefghijklmn",
    "tr_prod_sk_0123456789abcdefghijkl_",
  ])("rejects %s", (key) => {
    expect(isAdditionalApiKey(key)).toBe(false);
  });
});
