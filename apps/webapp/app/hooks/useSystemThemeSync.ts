import { useEffect } from "react";
import { type ThemePreference } from "~/utils/themePreference";

/**
 * Keeps `data-theme` on <html> in sync with the preference. For `system` it
 * follows the OS color scheme live; for pinned themes it writes the attribute
 * explicitly - React can skip the write when its virtual DOM already matched
 * the SSR fallback while the inline script had changed the real attribute.
 * The single resolution rule (dark vs light) lives here and in the blocking
 * inline script in root.tsx; downstream consumers react to the `data-theme`
 * mutation (see useThemeColor).
 */
export function useSystemThemeSync(preference: ThemePreference) {
  useEffect(() => {
    if (preference !== "system") {
      document.documentElement.setAttribute("data-theme", preference);
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
