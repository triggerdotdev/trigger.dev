import { KeyRound } from "lucide-react";
import { accessLabel } from "@/lib/api-access";
import { dashboardLink } from "@/lib/dashboard-link";

/** "Required access" on an API page: what an API key (or, for `pat`, a personal access token)
 * needs to call the endpoint. Same for every reader, so it renders on the server. */
export function RequiredAccess({
  access,
  pat = false,
}: {
  access: string[] | null;
  pat?: boolean;
}) {
  return (
    <div className="not-prose mb-6 flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-xl border bg-fd-card px-4 py-3 text-sm">
      <span className="flex items-center gap-1.5 font-medium">
        <KeyRound className="size-4 text-fd-primary" /> Required access
      </span>
      {access ? (
        <>
          {access.map((scope) => (
            <span key={scope} className="flex items-center gap-2">
              <span className="rounded-md border bg-fd-secondary px-2 py-0.5 text-fd-secondary-foreground">
                {accessLabel(scope)}
              </span>
              <code className="text-xs text-fd-muted-foreground">{scope}</code>
            </span>
          ))}
          <span className="text-xs text-fd-muted-foreground sm:ms-auto">
            {pat ? "A personal access token, from " : "Any key with this access, from "}
            <a
              href={dashboardLink(pat ? "/account/tokens" : "/_/apikeys")}
              className="underline underline-offset-2 hover:text-fd-foreground"
            >
              {pat ? "Personal access tokens" : "API keys"}
            </a>
          </span>
        </>
      ) : (
        <span className="text-fd-muted-foreground">
          None: this endpoint doesn&apos;t need an API key.
        </span>
      )}
    </div>
  );
}
