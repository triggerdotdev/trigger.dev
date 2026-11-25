"use client";
import type { ReactNode } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";

type Tab = { title: ReactNode; url: string; urls: string[] };

/** The three sections as tabs in the top bar from 1280px; narrower screens get fumadocs' tab row or the drawer. */
export function HeaderTabs({ tabs }: { tabs: Tab[] }) {
  const pathname = usePathname();
  return (
    <nav aria-label="Sections" className="ms-6 me-4 flex h-full items-stretch gap-5 max-xl:hidden">
      {tabs.map((t) => {
        const active = t.urls.includes(pathname);
        return (
          <Link
            key={t.url}
            href={t.url}
            prefetch={false}
            aria-current={active ? "page" : undefined}
            className="-mb-px inline-flex items-center border-b-2 border-transparent text-sm font-medium text-nowrap text-fd-muted-foreground transition-colors hover:text-fd-accent-foreground aria-[current=page]:border-fd-primary aria-[current=page]:text-fd-primary"
          >
            {t.title}
          </Link>
        );
      })}
    </nav>
  );
}
