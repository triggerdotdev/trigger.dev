import { SquarePen } from "lucide-react";
import { githubUrl } from "@/lib/source";

/** "Last updated" from the page's last commit (omitted without git history) and an edit link. */
export function PageFreshness({ path, updated }: { path: string; updated?: string }) {
  return (
    <div className="not-prose mt-6 flex flex-wrap items-center justify-between gap-x-4 gap-y-2 text-sm text-fd-muted-foreground">
      {updated ? (
        <p>
          Last updated{" "}
          <time dateTime={updated}>
            {new Date(updated).toLocaleDateString("en-US", {
              year: "numeric",
              month: "long",
              day: "numeric",
              timeZone: "UTC",
            })}
          </time>
        </p>
      ) : (
        <span />
      )}
      <a
        href={`${githubUrl}/edit/main/docs/${path}`}
        target="_blank"
        rel="noreferrer"
        className="inline-flex items-center gap-1.5 hover:text-fd-accent-foreground"
      >
        <SquarePen className="size-3.5" />
        Edit on GitHub
      </a>
    </div>
  );
}
