"use client";

import type { ReactNode } from "react";
import { RootProvider } from "fumadocs-ui/provider/next";
import DocsSearchDialog from "@/components/search-dialog";
import { basePath } from "@/lib/base-path";

export function DocsRootProvider({
  tags,
  children,
}: {
  /** Search filter tags (the nav's sections), from the server: lib/nav reads the content source. */
  tags: { name: string; value: string }[];
  children: ReactNode;
}) {
  return (
    <RootProvider
      theme={{ defaultTheme: "dark" }}
      search={{
        SearchDialog: DocsSearchDialog,
        options: { api: `${basePath}/api/search`, tags },
      }}
    >
      {children}
    </RootProvider>
  );
}
