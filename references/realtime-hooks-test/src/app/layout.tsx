import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Trigger.dev Hooks",
  description: "Realtime hooks testing workbench",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="dark">
      <body className="min-h-screen bg-background font-sans antialiased selection:bg-white/10">
        <div className="flex min-h-screen flex-col">
          <header className="sticky top-0 z-50 w-full border-b border-border/50 bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
            <div className="container flex h-14 max-w-screen-2xl items-center px-6">
              <a href="/" className="mr-6 flex items-center space-x-2">
                <span className="font-bold inline-block">⚡ Trigger.dev</span>
                <span className="text-muted-foreground px-2 py-0.5 rounded-full bg-secondary text-xs font-mono">Hooks Workbench</span>
              </a>
            </div>
          </header>
          <main className="flex-1 container max-w-screen-2xl py-6 px-6">
            {children}
          </main>
        </div>
      </body>
    </html>
  );
}
