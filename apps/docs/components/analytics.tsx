"use client";
import { useEffect, type ReactNode } from "react";
import { analytics, track } from "@/lib/analytics";

/** Starts PostHog (page views included) once the page has loaded. Renders nothing. */
export function Analytics() {
  useEffect(() => {
    void analytics();
  }, []);
  return null;
}

/** Reports clicks on the page actions (Copy Markdown, and the View as / Open in menu). */
export function TrackPageActions({ path, children }: { path: string; children: ReactNode }) {
  return (
    // React click events bubble through the menu's portal, so one listener covers both.
    <div
      className="contents"
      onClickCapture={(e) => {
        const el = e.target as HTMLElement;
        const link = el.closest("a");
        if (link) {
          // The item's label, without the icon's <title>.
          const target = [...link.childNodes]
            .filter((n) => n.nodeName.toLowerCase() !== "svg")
            .map((n) => n.textContent)
            .join("")
            .trim();
          track("docs_open_in_ai", { path, target, href: link.href });
        } else if (el.closest("button")?.textContent?.includes("Copy Markdown")) {
          track("docs_copy_markdown", { path });
        }
      }}
    >
      {children}
    </div>
  );
}
