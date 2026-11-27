"use client";

import { useState, type ReactNode } from "react";
import { Check, Copy, KeyRound, LogIn, Plus, Settings2 } from "lucide-react";
import { accessLabel } from "@/lib/api-access";
import { dashboardLink, signInLink } from "@/lib/dashboard-link";
import { createDocsKey, DocsKeyError, useCoveringKey } from "@/lib/docs-keys";
import type { ReaderProject } from "@/lib/reader";

const button =
  "inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md px-2.5 text-sm font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-fd-ring disabled:opacity-60 [&_svg]:size-3.5";
const primaryButton = `${button} bg-fd-primary text-fd-primary-foreground hover:bg-fd-primary/85`;
const secondaryButton = `${button} border bg-fd-background text-fd-foreground hover:bg-fd-accent`;
// Under a sample: text links, so the line stays quiet next to the code.
const link =
  "inline-flex shrink-0 items-center gap-1 rounded-sm font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-fd-ring disabled:opacity-60 [&_svg]:size-3.5";
export const primaryLink = `${link} text-fd-primary hover:underline`;
const secondaryLink = `${link} text-fd-muted-foreground hover:text-fd-foreground`;

/**
 * The reader's key for a sample or the playground: which key is filled in, or how to get one.
 * Under a sample it's one quiet line; `inset` makes it a full bar inside a panel (the playground's auth row).
 */
export function KeyBar({
  title,
  detail,
  actions,
  inset = false,
  hint,
  className = "",
}: {
  title: ReactNode;
  detail?: ReactNode;
  /** The full explanation, as a tooltip on the one-line form. */
  hint?: string;
  actions?: ReactNode;
  inset?: boolean;
  className?: string;
}) {
  if (!inset)
    return (
      <div
        className={`not-prose flex items-center gap-3 px-1 text-[0.8125rem] text-fd-muted-foreground ${className}`}
      >
        <KeyRound className="size-3.5 shrink-0" />
        {/* One line: the detail gives way (truncates) before the actions do. */}
        <p className="min-w-0 flex-1 truncate" title={hint}>
          <span className="text-fd-foreground">{title}</span>
          {detail && <span className="ml-2">{detail}</span>}
        </p>
        {actions && <div className="flex shrink-0 items-center gap-3">{actions}</div>}
      </div>
    );
  return (
    <div
      className={`not-prose flex flex-wrap items-center gap-x-3 gap-y-2 border-b bg-[color-mix(in_srgb,var(--color-fd-primary)_5%,transparent)] px-4 py-3 text-sm ${className}`}
    >
      <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-[color-mix(in_srgb,var(--color-fd-primary)_14%,transparent)] text-fd-primary">
        <KeyRound className="size-4" />
      </span>
      <div className="min-w-0 flex-1 basis-56 leading-snug">
        <p className="font-medium text-fd-foreground">{title}</p>
        {detail && <p className="mt-0.5 text-[0.8125rem] text-fd-muted-foreground">{detail}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

/** Which key a sample or the playground uses, or a one-click "Create a key" with exactly the access
 * it needs (`access` null: the default docs key). */
export function DocsKeyHint({
  project,
  needed,
  access,
  what,
  className,
}: {
  project: ReaderProject;
  needed: string[];
  access: string[] | null;
  what: "sample" | "endpoint";
  className?: string;
}) {
  const key = useCoveringKey(project, needed);
  const [state, setState] = useState<{
    busy?: boolean;
    error?: string;
    signIn?: boolean;
    copied?: boolean;
  }>({});
  const inset = what === "endpoint";
  const [primary, secondary] = inset
    ? [primaryButton, secondaryButton]
    : [primaryLink, secondaryLink];
  const manage = (label: string) => (
    <a href={dashboardLink("/_/apikeys?env=dev", project.ref)} className={secondary}>
      <Settings2 />
      {label}
    </a>
  );

  if (key) {
    return (
      <KeyBar
        inset={inset}
        className={className}
        title={<>Using your key &ldquo;{key.name}&rdquo;</>}
        hint={`For ${project.name} (development), kept in this tab only.`}
        detail={
          inset && (
            <>
              For <span className="font-medium text-fd-foreground">{project.name}</span>{" "}
              (development), kept in this tab only.
            </>
          )
        }
        actions={
          <>
            <button
              type="button"
              className={secondary}
              onClick={() =>
                navigator.clipboard.writeText(key.apiKey).then(() => setState({ copied: true }))
              }
            >
              {state.copied ? <Check /> : <Copy />}
              {state.copied ? "Copied" : "Copy key"}
            </button>
            {manage("Manage or revoke")}
          </>
        }
      />
    );
  }

  const title = access
    ? `${what === "endpoint" ? "Call this endpoint" : "Run this sample"} with your own key`
    : `Use your own dev key for ${project.name}`;
  return (
    <KeyBar
      inset={inset}
      className={className}
      title={title}
      hint={`Creates a development key for ${project.name}${
        access ? ` with ${access.map(accessLabel).join(", ")} access` : ""
      }. It's shown once and kept in this tab.`}
      detail={
        state.error ? (
          <span role="alert" className="text-fd-error">
            {state.error}
          </span>
        ) : inset ? (
          <>
            Creates a development key for{" "}
            <span className="font-medium text-fd-foreground">{project.name}</span>
            {access && <> with {access.map(accessLabel).join(", ")} access</>}. It&rsquo;s shown
            once and kept in this tab.
          </>
        ) : (
          access && access.map(accessLabel).join(", ")
        )
      }
      actions={
        <>
          <button
            type="button"
            disabled={state.busy}
            className={primary}
            onClick={() => {
              setState({ busy: true });
              createDocsKey(project.ref, access).then(
                () => setState({}),
                (error: Error) =>
                  setState({
                    error: error.message,
                    signIn: error instanceof DocsKeyError && error.signIn,
                  })
              );
            }}
          >
            <Plus />
            {state.busy ? "Creating…" : "Create key"}
          </button>
          {state.signIn && (
            <a href={signInLink(window.location.href)} className={secondary}>
              <LogIn />
              Sign in
            </a>
          )}
          {manage("Manage keys")}
        </>
      }
    />
  );
}
