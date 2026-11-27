import type { Metadata } from "next";
import type { ReactNode } from "react";
import { Analytics } from "@/components/analytics";
import { WebMcp } from "@/components/webmcp";
import { DocsRootProvider } from "@/components/root-provider";
import { askConfigured } from "@/lib/ask-config";
import { choiceScript } from "@/lib/choices";
import { sections } from "@/lib/nav";
import { siteUrl } from "@/lib/source";
import "./global.css";
import { basePath } from "@/lib/base-path";

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: { template: "%s - Trigger.dev", default: "Trigger.dev" },
  icons: { icon: `${basePath}/images/favicon.png` },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        {/* The reader's package manager and framework, set before the first paint (lib/choices.ts). */}
        <script dangerouslySetInnerHTML={{ __html: choiceScript }} />
      </head>
      <body className="flex min-h-screen flex-col">
        <DocsRootProvider ask={askConfigured()} tags={sections.map((s) => ({ name: s, value: s }))}>
          {children}
        </DocsRootProvider>
        <Analytics />
        <WebMcp />
      </body>
    </html>
  );
}
