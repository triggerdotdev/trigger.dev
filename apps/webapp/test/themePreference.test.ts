import { describe, expect, it } from "vitest";
import {
  getDashboardPreferences,
  normalizeThemePreference,
  type ThemePreference,
} from "~/services/dashboardPreferences.server";

const VALID_THEMES: ThemePreference[] = ["classic", "system", "dark", "light"];

describe("normalizeThemePreference", () => {
  it("returns each valid value unchanged", () => {
    for (const theme of VALID_THEMES) {
      expect(normalizeThemePreference(theme)).toBe(theme);
    }
  });

  it("falls back to classic for legacy/unknown values", () => {
    expect(normalizeThemePreference("solarized")).toBe("classic");
    expect(normalizeThemePreference("")).toBe("classic");
    expect(normalizeThemePreference(42)).toBe("classic");
    expect(normalizeThemePreference(null)).toBe("classic");
  });

  it("falls back to classic for undefined", () => {
    expect(normalizeThemePreference(undefined)).toBe("classic");
  });
});

describe("DashboardPreferences theme schema", () => {
  it("accepts all four theme values", () => {
    for (const theme of VALID_THEMES) {
      const result = getDashboardPreferences({ version: "1", projects: {}, theme });
      expect(result.theme).toBe(theme);
    }
  });

  it("accepts preferences without a theme", () => {
    const result = getDashboardPreferences({ version: "1", projects: {} });
    expect(result.theme).toBeUndefined();
  });

  it("rejects an invalid theme by falling back to defaults", () => {
    const result = getDashboardPreferences({ version: "1", projects: {}, theme: "neon" });
    expect(result.theme).toBeUndefined();
  });
});
