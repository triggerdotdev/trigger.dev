"use client";

import { usePathname } from "next/navigation";
import { DocsTitle } from "fumadocs-ui/layouts/notebook/page";
import { EmbedFrame } from "@/components/embed";
import { NotFoundSearch } from "@/components/not-found-search";
import { basePath } from "@/lib/base-path";

// A missing page in the dashboard's docs panel: search seeded from the path, and a way back in.
// EmbedFrame keeps these links inside the panel.
export default function EmbedNotFound() {
  const path = usePathname().replace(/^\/embed(?=\/)/, "");
  return (
    <EmbedFrame title="Not found" path={path}>
      <article className="mx-auto flex w-full max-w-[860px] flex-col gap-6 px-5 py-5">
        <header className="flex flex-col gap-2 border-b pb-5">
          <p className="font-mono text-sm text-fd-primary">404</p>
          <DocsTitle className="text-2xl">This page isn&rsquo;t in the docs any more</DocsTitle>
        </header>
        <NotFoundSearch />
        <p className="text-sm text-fd-muted-foreground">
          Or start from the{" "}
          <a
            href={`${basePath}/introduction`}
            className="font-medium text-fd-primary hover:underline"
          >
            docs home
          </a>
          .
        </p>
      </article>
    </EmbedFrame>
  );
}
