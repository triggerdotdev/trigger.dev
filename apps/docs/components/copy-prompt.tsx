"use client";
import { Check, Sparkles } from "lucide-react";
import { useState } from "react";
import { buttonVariants } from "fumadocs-ui/components/ui/button";
import { track } from "@/lib/analytics";
import { buildPrompt } from "@/lib/copy-prompt";
import { basePath } from "@/lib/base-path";

/** Copies a prompt an AI coding assistant can follow to do what this page describes. */
export function CopyPromptButton({
  path,
  title,
  mdUrl,
}: {
  path: string;
  title: string;
  mdUrl: string;
}) {
  const [state, setState] = useState<"idle" | "loading" | "copied" | "failed">("idle");
  const onClick = async () => {
    setState("loading");
    try {
      // The promise form keeps the click's permission in Safari while the page is fetched.
      const text = fetch(`${basePath}${path}.md`).then(async (res) => {
        if (!res.ok) throw new Error(`${res.status}`);
        return new Blob([buildPrompt(await res.text(), title, mdUrl)], { type: "text/plain" });
      });
      await navigator.clipboard.write([new ClipboardItem({ "text/plain": text })]);
      track("docs_copy_prompt", { path });
      setState("copied");
    } catch {
      setState("failed");
    }
    setTimeout(() => setState("idle"), 2000);
  };
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={state === "loading"}
      aria-live="polite"
      title="Copy a prompt for your AI coding assistant to follow this page"
      className={buttonVariants({
        variant: "secondary",
        size: "sm",
        className: "gap-2 [&_svg]:size-3.5 [&_svg]:text-fd-muted-foreground",
      })}
    >
      {state === "copied" ? <Check /> : <Sparkles />}
      {state === "copied" ? "Copied prompt" : state === "failed" ? "Couldn't copy" : "Copy prompt"}
    </button>
  );
}
