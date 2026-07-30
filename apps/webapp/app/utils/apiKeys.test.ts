import { describe, expect, test } from "vitest";
import {
  apiKeyPrefix,
  generateAdditionalApiKey,
  generateRootApiKey,
  hashApiKey,
  obfuscateApiKey,
} from "./apiKeys";

describe("API key utilities", () => {
  test.each([
    ["DEVELOPMENT", "tr_dev_"],
    ["STAGING", "tr_stg_"],
    ["PRODUCTION", "tr_prod_"],
    ["PREVIEW", "tr_preview_"],
  ] as const)("generates %s keys", (environmentType, prefix) => {
    const root = generateRootApiKey(environmentType);
    const additional = generateAdditionalApiKey(environmentType);

    expect(root.apiKey).toMatch(new RegExp(`^${prefix}[A-Za-z0-9]{24}$`));
    expect(root.keyHash).toBe(hashApiKey(root.apiKey));
    expect(root.lastFour).toBe(root.apiKey.slice(-4));
    expect(additional.apiKey).toMatch(new RegExp(`^${prefix}sk_[A-Za-z0-9]{24}$`));
    expect(additional.keyHash).toBe(hashApiKey(additional.apiKey));
    expect(additional.lastFour).toBe(additional.apiKey.slice(-4));
    expect(apiKeyPrefix(environmentType)).toBe(prefix);
    expect(obfuscateApiKey(environmentType, root.lastFour)).toBe(
      `${prefix}••••••••${root.lastFour}`
    );
    expect(obfuscateApiKey(environmentType, additional.lastFour, "additional")).toBe(
      `${prefix}sk_••••••••${additional.lastFour}`
    );
  });

  test("generates unique keys", () => {
    const keys = new Set(
      Array.from({ length: 100 }, () => generateAdditionalApiKey("PRODUCTION").apiKey)
    );

    expect(keys.size).toBe(100);
  });
});
