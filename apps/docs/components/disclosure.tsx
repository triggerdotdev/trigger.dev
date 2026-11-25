"use client";

import { useId, useState, type ReactNode } from "react";
import { ChevronRight } from "lucide-react";

// Shared by Accordion and Expandable: a real button with aria-expanded, content kept in the DOM
// (find-in-page and the markdown export still see it) and opened with a height transition.
export function Disclosure({
  summary,
  defaultOpen = false,
  variant,
  children,
}: {
  summary: ReactNode;
  defaultOpen?: boolean;
  variant: "accordion" | "expandable";
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const id = useId();
  const accordion = variant === "accordion";
  return (
    <div
      className={
        accordion
          ? "overflow-hidden border-b border-fd-border first:border-t"
          : "mt-2 rounded-md border border-fd-border"
      }
      data-state={open ? "open" : "closed"}
    >
      <button
        type="button"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((o) => !o)}
        className={
          accordion
            ? "flex w-full items-center gap-2.5 py-3.5 text-left text-[0.9375rem] font-medium text-fd-foreground outline-none hover:text-[var(--color-text-bright)] focus-visible:ring-2 focus-visible:ring-fd-ring"
            : "flex w-full items-center gap-1.5 rounded-md px-3 py-1.5 text-left text-[0.8125rem] text-fd-muted-foreground outline-none hover:bg-fd-accent/60 hover:text-fd-foreground focus-visible:ring-2 focus-visible:ring-fd-ring"
        }
      >
        <ChevronRight
          aria-hidden
          className={`size-4 shrink-0 text-fd-muted-foreground transition-transform duration-200 ${open ? "rotate-90" : ""}`}
        />
        {accordion ? (
          summary
        ) : (
          <span>
            {open ? "Hide" : "Show"} {summary}
          </span>
        )}
      </button>
      <div
        id={id}
        inert={!open}
        className="grid transition-[grid-template-rows] duration-200 ease-out"
        style={{ gridTemplateRows: open ? "1fr" : "0fr" }}
      >
        <div className="min-h-0 overflow-hidden">
          <div
            className={
              accordion
                ? "pb-4 pl-[1.625rem] [&>:first-child]:mt-0 [&>:last-child]:mb-0"
                : "border-t border-fd-border px-3 [&>:first-child]:mt-0"
            }
          >
            {children}
          </div>
        </div>
      </div>
    </div>
  );
}
