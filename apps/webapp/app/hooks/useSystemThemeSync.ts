import { useEffect } from "react";
import { type ThemePreference } from "~/utils/themePreference";

/**
 * When the preference is `system`, keep `data-theme` on <html> in sync with the
 * OS color scheme live. The single resolution rule (dark vs light) lives here
 * and in the blocking inline script in root.tsx; downstream consumers react to
 * the `data-theme` mutation (see useThemeColor). No-op for pinned themes.
 */
export function useSystemThemeSync(preference: ThemePreference) {
  useEffect(() => {
    if (preference !== "system") {
      return;
    }

    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      document.documentElement.setAttribute("data-theme", media.matches ? "dark" : "light");
    };

    apply();
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [preference]);
}
