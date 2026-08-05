import { useEffect, useState } from "react";

export type ThemeMode = "dark" | "light";

// Resolved in an effect so server and hydration renders agree; `root.tsx` can flip
// `data-theme` pre-paint.
export function useThemeMode(): ThemeMode {
  const [mode, setMode] = useState<ThemeMode>("dark");
  useEffect(() => {
    const resolve = () => {
      setMode(document.documentElement.getAttribute("data-theme") === "light" ? "light" : "dark");
    };
    resolve();
    const observer = new MutationObserver(resolve);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });
    return () => observer.disconnect();
  }, []);
  return mode;
}
