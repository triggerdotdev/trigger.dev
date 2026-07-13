import { describe, expect, it } from "vitest";
import { normalizePromptOverrideSource } from "../app/v3/services/promptOverrideSource.js";

// Invariant: an override-creation path must never write the reserved
// `source: "code"`. Anything that isn't a legitimate caller value
// collapses to "dashboard".
describe("normalizePromptOverrideSource", () => {
  it("never lets the privileged 'code' value through", () => {
    expect(normalizePromptOverrideSource("code")).toBe("dashboard");
  });

  it("passes through caller-supplied non-code sources", () => {
    expect(normalizePromptOverrideSource("api")).toBe("api");
    expect(normalizePromptOverrideSource("dashboard")).toBe("dashboard");
    expect(normalizePromptOverrideSource("sdk")).toBe("sdk");
  });

  it("defaults missing/empty source to 'dashboard'", () => {
    expect(normalizePromptOverrideSource(undefined)).toBe("dashboard");
    expect(normalizePromptOverrideSource(null)).toBe("dashboard");
    expect(normalizePromptOverrideSource("")).toBe("dashboard");
  });
});
