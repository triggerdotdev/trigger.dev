"use client";

import { useEffect, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { dashboardOrigin } from "@/lib/dashboard-link";
import { embedLink, embedPageMessage } from "@/lib/embed";

/** Keeps docs links inside the embed and tells the dashboard which page is showing. */
export function EmbedFrame({
  title,
  path,
  children,
}: {
  title: string;
  path: string;
  children: ReactNode;
}) {
  const router = useRouter();

  useEffect(() => {
    // Nothing private: the parent learns the page it already asked for.
    const publish = () => postPage(title, path, window.location.hash);
    publish();
    // Back and Forward between sections of this page, and fragment changes outside the router.
    window.addEventListener("popstate", publish);
    window.addEventListener("hashchange", publish);
    return () => {
      window.removeEventListener("popstate", publish);
      window.removeEventListener("hashchange", publish);
    };
  }, [title, path]);

  useEffect(() => {
    // Capture phase, before next/link's own handler, so its navigation never runs.
    const onClick = (event: MouseEvent) => {
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
        return;
      }
      const anchor = (event.target as Element | null)?.closest?.("a[href]");
      if (
        !(anchor instanceof HTMLAnchorElement) ||
        anchor.target ||
        anchor.hasAttribute("download")
      ) {
        return;
      }
      const link = embedLink(anchor.href, window.location.href, dashboardOrigin);
      if (!link) return;
      if ("hash" in link) {
        // Through the router, so Back restores this entry; pushState fires no event to report it.
        event.preventDefault();
        event.stopPropagation();
        router.push(link.hash);
        postPage(title, path, link.hash);
        // The router only scrolls; move focus too, so Tab continues from the section like a native jump.
        const section = document.getElementById(decodeURIComponent(link.hash.slice(1)));
        if (section) {
          // Only for targets that can't take focus; a focusable one (a link) keeps its tab stop.
          if (section.tabIndex < 0 && !section.hasAttribute("tabindex")) {
            section.setAttribute("tabindex", "-1");
          }
          section.focus({ preventScroll: true });
        }
        return;
      }
      if ("target" in link) {
        anchor.target = link.target;
        if (link.target === "_blank") anchor.rel = "noreferrer";
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      router.push(link.embed);
    };
    document.addEventListener("click", onClick, true);
    return () => document.removeEventListener("click", onClick, true);
  }, [router, title, path]);

  return children;
}

function postPage(title: string, path: string, hash: string) {
  if (window.parent !== window) window.parent.postMessage(embedPageMessage(title, path, hash), "*");
}
