import type { ReactNode } from "react";
import { DocsLayout } from "fumadocs-ui/layouts/notebook";
import { LayoutDashboard } from "lucide-react";
import { HeaderTabs } from "@/components/header-tabs";
import { Logo } from "@/components/logo";
import { dashboardLink } from "@/lib/dashboard-link";
import { pageTree, sectionTabs as tabs } from "@/lib/nav";
import { githubUrl } from "@/lib/source";

export default function Layout({ children }: { children: ReactNode }) {
  return (
    <DocsLayout
      tree={pageTree}
      tabMode="navbar"
      tabs={tabs}
      // Pages are static and CDN-cached: fetch one on click instead of every sidebar link in view.
      sidebar={{ prefetch: false }}
      nav={{
        mode: "top",
        title: (
          <>
            <Logo className="h-[22px] w-[127px] max-w-none shrink-0" />
            <span className="sr-only">docs</span>
          </>
        ),
        url: "https://trigger.dev",
        children: <HeaderTabs tabs={tabs.map((t) => ({ ...t, urls: [...t.urls] }))} />,
      }}
      githubUrl={githubUrl}
      links={[
        {
          type: "button",
          text: "Dashboard",
          icon: <LayoutDashboard />,
          url: dashboardLink(),
          external: true,
          secondary: true,
        },
      ]}
    >
      {children}
    </DocsLayout>
  );
}
