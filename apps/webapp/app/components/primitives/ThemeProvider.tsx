import { useFetcher } from "@remix-run/react";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import type { ThemePreference } from "~/services/dashboardPreferences.server";

type Theme = "light" | "dark";

interface ThemeContextValue {
  theme: Theme;
  themePreference: ThemePreference;
  setThemePreference: (preference: ThemePreference) => void;
}

const ThemeContext = createContext<ThemeContextValue | undefined>(undefined);

function getSystemTheme(): Theme {
  if (typeof window === "undefined") {
    return "dark";
  }
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function resolveTheme(preference: ThemePreference): Theme {
  if (preference === "system") {
    return getSystemTheme();
  }
  return preference;
}

interface ThemeProviderProps {
  children: ReactNode;
  initialPreference?: ThemePreference;
  isLoggedIn?: boolean;
}

export function ThemeProvider({
  children,
  initialPreference = "dark",
  isLoggedIn = false,
}: ThemeProviderProps) {
  const [themePreference, setThemePreferenceState] = useState<ThemePreference>(initialPreference);
  const [theme, setTheme] = useState<Theme>(() => resolveTheme(initialPreference));
  const fetcher = useFetcher();

  // Update the HTML class when theme changes
  useEffect(() => {
    const root = document.documentElement;
    root.classList.remove("light", "dark");
    root.classList.add(theme);
  }, [theme]);

  // Listen for system theme changes when preference is "system"
  useEffect(() => {
    if (themePreference !== "system") {
      return;
    }

    const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
    const handleChange = (e: MediaQueryListEvent) => {
      setTheme(e.matches ? "dark" : "light");
    };

    mediaQuery.addEventListener("change", handleChange);
    return () => mediaQuery.removeEventListener("change", handleChange);
  }, [themePreference]);

  const setThemePreference = useCallback(
    (preference: ThemePreference) => {
      setThemePreferenceState(preference);
      setTheme(resolveTheme(preference));

      // Persist to server if logged in
      if (isLoggedIn) {
        fetcher.submit(
          { theme: preference },
          { method: "POST", action: "/resources/preferences/theme" }
        );
      }

      // Also store in localStorage for non-logged-in users and faster hydration
      localStorage.setItem("theme-preference", preference);
    },
    [isLoggedIn, fetcher]
  );

  return (
    <ThemeContext.Provider value={{ theme, themePreference, setThemePreference }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  const context = useContext(ThemeContext);
  if (context === undefined) {
    throw new Error("useTheme must be used within a ThemeProvider");
  }
  return context;
}

// Script to prevent flash of wrong theme on initial load
// This should be injected into the <head> before any content renders
export function ThemeScript({ initialPreference }: { initialPreference?: ThemePreference }) {
  const script = `
    (function() {
      var preference = ${JSON.stringify(initialPreference ?? null)} || localStorage.getItem('theme-preference') || 'dark';
      var theme = preference;
      if (preference === 'system') {
        theme = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
      }
      document.documentElement.classList.add(theme);
    })();
  `;

  return <script dangerouslySetInnerHTML={{ __html: script }} />;
}
