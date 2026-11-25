"use client";
import { Suspense, use, type ReactNode } from "react";
import { usePathname } from "next/navigation";
import { Popup, PopupContent, PopupTrigger } from "fumadocs-twoslash/ui";
import { basePath } from "@/lib/base-path";

// Popup HTML for each page's type hovers (lib/rehype-code-weight.ts), fetched once per page on
// the first hover or focus instead of shipping with the page.
const loaded = new Map<string, Promise<string[]>>();
function hoversFor(path: string) {
  let hovers = loaded.get(path);
  if (!hovers) {
    hovers = fetch(`${basePath}/hovers${path}`)
      .then((res) => (res.ok ? (res.json() as Promise<string[]>) : []))
      .catch(() => []);
    loaded.set(path, hovers);
  }
  return hovers;
}

function HoverBody({ path, hover }: { path: string; hover: number }) {
  const html = use(hoversFor(path))[Number(hover)];
  return html ? <div dangerouslySetInnerHTML={{ __html: html }} /> : null;
}

/** `hover` indexes the page's hovers; a snippet's popups carry their `html` inline. */
export function TypeHover({
  hover,
  html,
  children,
}: {
  hover?: number;
  html?: string;
  children: ReactNode;
}) {
  // An embed page (/embed/<page>) shows the same page, so it reads that page's hovers.
  const path = usePathname().replace(/^\/embed(?=\/)/, "");
  const prefetch = () => void (html === undefined && hoversFor(path));
  return (
    <Popup>
      <PopupContent>
        <Suspense fallback={<div className="text-fd-muted-foreground">Loading type…</div>}>
          {html !== undefined ? (
            <div dangerouslySetInnerHTML={{ __html: html }} />
          ) : (
            <HoverBody path={path} hover={hover ?? 0} />
          )}
        </Suspense>
      </PopupContent>
      {/* PopupTrigger owns onPointerEnter; pointerover and focus start the fetch early. */}
      <PopupTrigger onPointerOver={prefetch} onFocus={prefetch}>
        {children}
      </PopupTrigger>
    </Popup>
  );
}
