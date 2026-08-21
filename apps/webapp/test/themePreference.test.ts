import { describe, expect, it } from "vitest";
import { parseDashboardPreferences } from "~/utils/dashboardPreferences";
import { normalizeThemePreference, type ThemePreference } from "~/utils/themePreference";

const VALID_THEMES: ThemePreference[] = ["system", "dark", "light", "black", "white"];

describe("normalizeThemePreference", () => {
  it("returns each valid value unchanged", () => {
    for (const theme of VALID_THEMES) {
      expect(normalizeThemePreference(theme)).toBe(theme);
    }
  });

  it("falls back to dark for legacy/unknown values", () => {
    // Classic is retired. Anyone still holding it lands on Dark, which at
    // contrast 0 renders the palette Classic used to ship.
    expect(normalizeThemePreference("classic")).toBe("dark");
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
  it("accepts every theme value", () => {
    for (const theme of VALID_THEMES) {
      const result = parseDashboardPreferences({ version: "1", projects: {}, theme });
      expect(result.theme).toBe(theme);
    }
  });

  it("drops a stored classic theme", () => {
    const result = parseDashboardPreferences({ version: "1", projects: {}, theme: "classic" });
    expect(result.theme).toBeUndefined();
  });

  it("accepts preferences without a theme", () => {
    const result = parseDashboardPreferences({ version: "1", projects: {} });
    expect(result.theme).toBeUndefined();
  });

  it("drops an invalid theme without erasing the rest of the preferences", () => {
    const result = parseDashboardPreferences({
      version: "1",
      projects: {},
      theme: "neon",
      contrast: 999,
      currentProjectId: "proj_123",
      sideMenu: { isCollapsed: true },
    });
    expect(result.theme).toBeUndefined();
    expect(result.contrast).toBeUndefined();
    expect(result.currentProjectId).toBe("proj_123");
    expect(result.sideMenu?.isCollapsed).toBe(true);
  });

  it("keeps keys it does not know about, so a full-blob write cannot erase them", () => {
    const result = parseDashboardPreferences({
      version: "1",
      projects: {},
      theme: "dark",
      somethingANewerDeployAdded: { nested: true },
    });
    expect(result.theme).toBe("dark");
    expect(result).toHaveProperty("somethingANewerDeployAdded", { nested: true });
  });
});
