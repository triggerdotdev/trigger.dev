"use client";

import { useState } from "react";
import {
  Check,
  ChevronsUpDown,
  Copy,
  Folder,
  KeyRound,
  LayoutDashboard,
  LogOut,
} from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "fumadocs-ui/components/ui/popover";
import { dashboardLink } from "@/lib/dashboard-link";
import { accessLabel } from "@/lib/api-access";
import { forgetDocsKey, useDocsKeys } from "@/lib/docs-keys";
import { pickProject, useReader } from "@/lib/reader";

/** The dashboard's organization badge: two letters on an indigo square. */
function OrgBadge({ title, size = "sm" }: { title: string; size?: "sm" | "md" }) {
  return (
    <span
      aria-hidden
      className={`flex shrink-0 items-center justify-center rounded-[3px] bg-indigo-500 font-semibold text-white ${
        size === "md" ? "size-5 text-[10px]" : "size-4 text-[9px]"
      }`}
    >
      {title.slice(0, 2)}
    </span>
  );
}

const item =
  "flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-sm text-fd-foreground hover:bg-fd-accent [&_svg]:size-4 [&_svg]:shrink-0";

/** The selected project's ref, copied on click (it goes in trigger.config.ts and the CLI). */
function CopyRef({ projectRef }: { projectRef: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className={item}
      onClick={() => {
        void navigator.clipboard.writeText(projectRef);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
    >
      {copied ? (
        <Check className="text-fd-muted-foreground" />
      ) : (
        <Copy className="text-fd-muted-foreground" />
      )}
      <span className="shrink-0 whitespace-nowrap">{copied ? "Copied" : "Copy project ref"}</span>
      <span
        className="ml-auto min-w-0 truncate font-mono text-xs text-fd-muted-foreground"
        title={projectRef}
      >
        {projectRef}
      </span>
    </button>
  );
}

/** The signed-in reader in the top bar: one menu with their projects by organization (like the
 * dashboard's org and project switchers), the tab's docs keys, and dashboard links. */
export function ReaderMenu() {
  const reader = useReader();
  const keys = useDocsKeys();
  if (reader.kind !== "signed-in") return null;
  const { projects, project } = reader;
  // The current project's org first, so the checked row is visible when the menu opens.
  const orgs = [...new Set([project?.orgTitle, ...projects.map((p) => p.orgTitle)])].filter(
    (o): o is string => !!o
  );

  return (
    <Popover>
      <PopoverTrigger
        title="Code samples use this project's ref and dev key"
        className="inline-flex max-w-60 shrink-0 items-center gap-2 rounded-md border bg-fd-secondary px-2 py-1.5 text-sm text-fd-foreground hover:bg-fd-accent"
      >
        {project && <OrgBadge title={project.orgTitle} size="md" />}
        <span className="truncate">{project?.name ?? "No project"}</span>
        <ChevronsUpDown className="size-3.5 shrink-0 text-fd-muted-foreground" />
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[23rem] max-w-[calc(100vw-2rem)] p-1">
        <div className="max-h-[22rem] overflow-y-auto">
          {orgs.map((org, i) => (
            <div key={org} className={i > 0 ? "mt-1 border-t pt-1" : ""}>
              <p className="flex h-8 items-center gap-2 px-2 text-xs font-medium text-fd-muted-foreground">
                <OrgBadge title={org} />
                <span className="truncate">{org}</span>
              </p>
              {projects
                .filter((p) => p.orgTitle === org)
                .map((p) => (
                  <button
                    key={p.ref}
                    type="button"
                    title={p.ref}
                    onClick={() => pickProject(p.ref)}
                    className={item}
                  >
                    <Folder className="text-indigo-500" />
                    <span className="min-w-0 flex-1 truncate">{p.name}</span>
                    {p.ref === project?.ref && <Check className="text-fd-foreground" />}
                  </button>
                ))}
            </div>
          ))}
        </div>
        {keys.length > 0 && (
          <div className="mt-1 border-t pt-1">
            <p className="flex h-8 items-center px-2 text-xs font-medium text-fd-muted-foreground">
              Docs keys in this tab
            </p>
            {keys.map((key) => (
              <div
                key={key.apiKey}
                className="group flex items-center gap-2 rounded-md px-2 py-1.5 text-sm"
              >
                <KeyRound className="size-4 shrink-0 text-fd-muted-foreground" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-fd-foreground">{key.name}</span>
                  <span className="block truncate text-xs text-fd-muted-foreground">
                    {projects.find((p) => p.ref === key.projectRef)?.name ?? key.projectRef}{" "}
                    &middot;{" "}
                    {key.access ? key.access.map(accessLabel).join(", ") : "Default docs key"}
                  </span>
                </span>
                <a
                  href={dashboardLink("/_/apikeys?env=dev", key.projectRef)}
                  className="text-xs text-fd-muted-foreground hover:text-fd-foreground"
                >
                  Manage
                </a>
                <button
                  type="button"
                  onClick={() => forgetDocsKey(key.apiKey)}
                  className="text-xs text-fd-muted-foreground hover:text-fd-foreground"
                >
                  Forget
                </button>
              </div>
            ))}
          </div>
        )}
        <div className="mt-1 border-t pt-1">
          {project && <CopyRef projectRef={project.ref} />}
          <a href={dashboardLink("/_/", project?.ref)} className={item}>
            <LayoutDashboard className="text-fd-muted-foreground" /> Open in dashboard
          </a>
          {/* A POST: the dashboard only signs out a GET from its own pages. */}
          <form method="post" action={dashboardLink("/logout")}>
            <button type="submit" className={item}>
              <LogOut className="text-fd-muted-foreground" /> Sign out
            </button>
          </form>
        </div>
      </PopoverContent>
    </Popover>
  );
}
