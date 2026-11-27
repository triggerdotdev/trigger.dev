import type { ReactNode } from "react";
import { embedThemeScript } from "@/lib/embed";

// Embed pages are for the dashboard's docs panel only (next.config.mjs sends X-Robots-Tag: noindex).
export default function EmbedLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <script dangerouslySetInnerHTML={{ __html: embedThemeScript }} />
      <main className="flex flex-1 flex-col">{children}</main>
    </>
  );
}
