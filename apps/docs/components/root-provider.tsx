"use client";

import { useState, type ReactNode } from "react";
import { usePathname } from "next/navigation";
import { RootProvider } from "fumadocs-ui/provider/next";
import DocsSearchDialog from "@/components/search-dialog";
import { basePath } from "@/lib/base-path";

/** `?theme=dark|light` on an embed page: the dashboard's theme, without touching the saved one. */
function embedTheme(): "dark" | "light" | undefined {
  if (typeof window === "undefined") return undefined;
  const theme = new URLSearchParams(window.location.search).get("theme");
  return theme === "dark" || theme === "light" ? theme : undefined;
}

export function DocsRootProvider({
  ask,
  tags,
  children,
}: {
  ask: boolean;
  /** Search filter tags (the nav's sections), from the server: lib/nav reads the content source. */
  tags: { name: string; value: string }[];
  children: ReactNode;
}) {
  const embed = usePathname().startsWith("/embed/");
  // Read once in the browser; the server render has no query. The pre-paint script in the
  // embed layout already applied it, so there's no flash.
  const [forcedTheme] = useState(() => (embed ? embedTheme() : undefined));
  return (
    <RootProvider
      theme={{ defaultTheme: "dark", forcedTheme }}
      search={{
        // Search results open full pages, which don't belong inside the dashboard panel.
        enabled: !embed,
        SearchDialog: DocsSearchDialog,
        options: {
          api: `${basePath}/api/search`,
          tags,
          // Passed through to DocsSearchDialog (fumadocs' option type doesn't list it).
          ...{ ask },
        },
      }}
    >
      {children}
    </RootProvider>
  );
}
