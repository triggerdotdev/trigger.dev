import { describe, expect, it } from "vitest";
import { parseDashboardPreferences } from "~/utils/dashboardPreferences";
import { normalizeThemePreference, type ThemePreference } from "~/utils/themePreference";

const VALID_THEMES: ThemePreference[] = ["classic", "system", "dark", "light"];

describe("normalizeThemePreference", () => {
  it("returns each valid value unchanged", () => {
    for (const theme of VALID_THEMES) {
      expect(normalizeThemePreference(theme)).toBe(theme);
    }
  });

  it("falls back to dark for legacy/unknown values", () => {
    expect(normalizeThemePreference("solarized")).toBe("dark");
    expect(normalizeThemePreference("")).toBe("dark");
    expect(normalizeThemePreference(42)).toBe("dark");
    expect(normalizeThemePreference(null)).toBe("dark");
  });

  it("falls back to dark for undefined", () => {
    expect(normalizeThemePreference(undefined)).toBe("dark");
  });
});

describe("DashboardPreferences theme schema", () => {
  it("accepts all four theme values", () => {
    for (const theme of VALID_THEMES) {
      const result = parseDashboardPreferences({ version: "1", projects: {}, theme });
      expect(result.theme).toBe(theme);
    }
  });

  it("accepts preferences without a theme", () => {
    const result = parseDashboardPreferences({ version: "1", projects: {} });
    expect(result.theme).toBeUndefined();
  });

  it("rejects an invalid theme by falling back to defaults", () => {
    const result = parseDashboardPreferences({ version: "1", projects: {}, theme: "neon" });
    expect(result.theme).toBeUndefined();
  });
});
