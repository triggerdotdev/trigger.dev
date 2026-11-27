"use client";

import dynamic from "next/dynamic";
import { Sparkles } from "lucide-react";
import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { buttonVariants } from "fumadocs-ui/components/ui/button";
import {
  SearchTrigger,
  type SearchTriggerProps,
} from "fumadocs-ui/layouts/shared/slots/search-trigger";
import type { PageContext } from "./ask-panel";

// The conversation and the AI SDK load on the first open, not with every page.
const AskPanel = dynamic(() => import("./ask-panel").then((m) => m.AskPanel));

const OPEN_EVENT = "ask-ai:open";

/** Opens the panel from anywhere. It always knows the page the reader is on. */
export function openAskAI() {
  window.dispatchEvent(new Event(OPEN_EVENT));
}

export function AskAIButton() {
  return (
    <button
      type="button"
      onClick={() => openAskAI()}
      className="inline-flex shrink-0 items-center gap-1.5 rounded-md border bg-fd-secondary px-2.5 py-1.5 text-sm whitespace-nowrap text-fd-secondary-foreground hover:bg-fd-accent"
    >
      <Sparkles className="size-3.5 text-fd-primary" />
      Ask AI
      <kbd className="ms-1 hidden rounded border px-1 font-sans text-[11px] text-fd-muted-foreground xl:inline">
        ⌘I
      </kbd>
    </button>
  );
}

// The phone header only renders the small search slot, so Ask AI sits beside it there.
export function PhoneSearchAndAsk(props: SearchTriggerProps) {
  return (
    <>
      <button
        type="button"
        aria-label="Ask AI"
        onClick={() => openAskAI()}
        className={buttonVariants({ size: "icon-sm", variant: "ghost", className: "p-2" })}
      >
        <Sparkles className="text-fd-primary" />
      </button>
      <SearchTrigger {...props} />
    </>
  );
}

export function AskAIPanel() {
  const [open, setOpen] = useState(false);
  // The page being read is context for every question, until the reader drops it for that page.
  const pathname = usePathname();
  const [page, setPage] = useState<PageContext>();
  useEffect(() => {
    const title = document.querySelector("article h1, main h1")?.textContent?.trim();
    setPage(pathname && pathname !== "/" && title ? { path: pathname, title } : undefined);
  }, [pathname]);
  const [input, setInput] = useState("");

  useEffect(() => {
    const onOpen = () => setOpen(true);
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "i") {
        e.preventDefault();
        setOpen((o) => !o);
      } else if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener(OPEN_EVENT, onOpen);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener(OPEN_EVENT, onOpen);
      window.removeEventListener("keydown", onKey);
    };
  }, []);

  if (!open) return null;
  return (
    <AskPanel
      page={page}
      dropPage={() => setPage(undefined)}
      input={input}
      setInput={setInput}
      close={() => setOpen(false)}
    />
  );
}
