"use client";
import { useLayoutEffect, useState, type ReactNode } from "react";
import { Tabs } from "fumadocs-ui/components/tabs";
import { CodeBlockTabs } from "fumadocs-ui/components/codeblock";
import { choiceCookie, isChoice, type ChoiceKind } from "@/lib/choices";
import { basePath } from "@/lib/base-path";

const EVENT = "docs-choice";

function readChoice(kind: ChoiceKind) {
  const v = document.documentElement.getAttribute(`data-${kind}`);
  return isChoice(kind, v) ? v : undefined;
}

/** Saves a choice for every tab group on this page and the next ones. */
function setChoice(kind: ChoiceKind, slug: string) {
  document.documentElement.setAttribute(`data-${kind}`, slug);
  document.cookie = `${choiceCookie(kind)}=${slug}; path=/; max-age=31536000; samesite=lax`;
  const url = new URL(location.href);
  if (url.searchParams.has(kind)) {
    url.searchParams.set(kind, slug);
    history.replaceState(history.state, "", url);
  }
  // Links copied or opened in a new tab carry the framework, so a shared link shows the same code.
  if (kind === "framework")
    for (const a of document.querySelectorAll<HTMLAnchorElement>(`a[href^="${basePath}/"]`)) {
      const href = new URL(a.href);
      href.searchParams.set(kind, slug);
      a.setAttribute("href", href.pathname + href.search + href.hash);
    }
  window.dispatchEvent(new CustomEvent(EVENT, { detail: kind }));
}

/**
 * A tab group whose labels name packages managers or frameworks. `slugs[i]` is tab i's option
 * (undefined when its label names none), `values[i]` its tab value. Server-rendered with the first
 * tab active; the layout's CSS shows the reader's choice until this takes over, before paint.
 */
export function ChoiceTabs({
  kind,
  slugs,
  values,
  variant,
  children,
}: {
  kind: ChoiceKind;
  slugs: (string | undefined)[];
  values: string[];
  variant: "tabs" | "code";
  children: ReactNode;
}) {
  const [chosen, setChosen] = useState<string>();
  // A tab with no option (say "Raw node:http") is picked for this group only.
  const [local, setLocal] = useState<string>();

  useLayoutEffect(() => {
    const sync = (e?: Event) => {
      if (e && (e as CustomEvent).detail !== kind) return;
      setChosen(readChoice(kind));
      setLocal(undefined);
    };
    sync();
    document.documentElement.setAttribute("data-choices-ready", "");
    window.addEventListener(EVENT, sync);
    return () => window.removeEventListener(EVENT, sync);
  }, [kind]);

  const idx = chosen ? slugs.indexOf(chosen) : -1;
  const value = local ?? (idx >= 0 ? values[idx] : values[0]);
  const Root = variant === "code" ? CodeBlockTabs : Tabs;
  return (
    <Root
      data-choice-group={kind}
      value={value}
      onValueChange={(v: string) => {
        const slug = slugs[values.indexOf(v)];
        if (slug) setChoice(kind, slug);
        else setLocal(v);
      }}
    >
      {children}
    </Root>
  );
}
