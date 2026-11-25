import { DocsBody, DocsPage, DocsTitle } from "fumadocs-ui/layouts/notebook/page";
import { NotFoundSearch } from "@/components/not-found-search";
import { sectionTabs } from "@/lib/nav";
import { basePath } from "@/lib/base-path";

// Page-not-found inside the docs layout: the requested path, search seeded from its words,
// and the three sections.
export default function NotFound() {
  return (
    <DocsPage toc={[]} full>
      <p className="font-mono text-sm text-fd-primary">404</p>
      <DocsTitle>This page doesn't exist</DocsTitle>
      <DocsBody>
        <NotFoundSearch />
        <h2 className="mt-10 text-base font-semibold">Or start from a section</h2>
        <div className="not-prose mt-3 grid gap-3 sm:grid-cols-3">
          {sectionTabs.map((t) => (
            <a
              key={t.url}
              href={`${basePath}${t.url}`}
              className="rounded-lg border bg-fd-card p-4 transition-colors hover:border-fd-primary/50 hover:bg-fd-accent"
            >
              <p className="text-sm font-medium text-fd-foreground">{t.title}</p>
              {t.description && (
                <p className="mt-1 text-sm text-fd-muted-foreground">{t.description}</p>
              )}
            </a>
          ))}
        </div>
      </DocsBody>
    </DocsPage>
  );
}
