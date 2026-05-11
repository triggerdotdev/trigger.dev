import { XMarkIcon } from "@heroicons/react/20/solid";
import { useLayoutEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import { cn } from "~/utils/cn";

function sanitizeActionUrl(url?: string): string | undefined {
  if (!url) return undefined;
  const trimmed = url.trim();
  if (!trimmed) return undefined;

  try {
    const parsed = new URL(trimmed, window.location.origin);
    if (parsed.protocol === "http:" || parsed.protocol === "https:") {
      return parsed.toString();
    }
  } catch {
    return undefined;
  }

  return undefined;
}

export function NotificationCard({
  title,
  description,
  image,
  actionUrl,
  onDismiss,
  onCardClick,
  onLinkClick,
}: {
  title: string;
  description: string;
  image?: string;
  actionUrl?: string;
  onDismiss?: () => void;
  onCardClick?: () => void;
  onLinkClick?: () => void;
}) {
  const [isExpanded, setIsExpanded] = useState(false);
  const [isOverflowing, setIsOverflowing] = useState(false);
  const descriptionRef = useRef<HTMLDivElement>(null);
  const safeActionUrl = sanitizeActionUrl(actionUrl);

  useLayoutEffect(() => {
    const el = descriptionRef.current;
    if (!el) return;

    const check = () => setIsOverflowing(el.scrollHeight - el.clientHeight > 1);
    check();

    const observer = new ResizeObserver(check);
    observer.observe(el);
    return () => observer.disconnect();
  }, [description]);

  const handleDismiss = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    onDismiss?.();
  };

  const handleToggleExpand = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsExpanded((v) => !v);
  };

  return (
    <div className="group/card relative overflow-hidden rounded border border-charcoal-650 bg-charcoal-700/50 shadow-lg">
      {safeActionUrl && (
        <a
          href={safeActionUrl}
          target="_blank"
          rel="noopener noreferrer"
          aria-label={title}
          onClick={onCardClick}
          className="absolute inset-0 z-10"
        />
      )}

      <div className="flex items-start gap-1 px-2.5 pt-2">
        <p className="flex-1 text-[13px] font-medium leading-normal text-text-bright">{title}</p>
        <button
          type="button"
          onClick={handleDismiss}
          className="relative z-20 -mr-1 shrink-0 rounded p-0.5 text-text-dimmed opacity-0 transition group-hover/card:opacity-100 hover:bg-charcoal-700 hover:text-text-bright"
        >
          <XMarkIcon className="size-3.5" />
        </button>
      </div>

      <div className="px-2.5 pb-2">
        <div ref={descriptionRef} className={cn(!isExpanded && "line-clamp-3")}>
          <ReactMarkdown components={getMarkdownComponents(onLinkClick)}>
            {description}
          </ReactMarkdown>
        </div>
        {(isOverflowing || isExpanded) && (
          <button
            type="button"
            onClick={handleToggleExpand}
            className="relative z-20 mt-0.5 text-xs text-indigo-400 hover:text-indigo-300"
          >
            {isExpanded ? "Show less" : "Show more"}
          </button>
        )}

        {image && <img src={sanitizeImageUrl(image)} alt="" className="mt-1.5 rounded" />}
      </div>
    </div>
  );
}

function getMarkdownComponents(onLinkClick?: () => void) {
  return {
    p: ({ children }: { children?: React.ReactNode }) => (
      <p className="my-0.5 text-xs leading-normal text-text-dimmed">{children}</p>
    ),
    a: ({ href, children }: { href?: string; children?: React.ReactNode }) => (
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className="relative z-20 text-indigo-400 underline transition-colors hover:text-indigo-300"
        onClick={(e) => {
          e.stopPropagation();
          onLinkClick?.();
        }}
      >
        {children}
      </a>
    ),
    strong: ({ children }: { children?: React.ReactNode }) => (
      <strong className="font-semibold text-text-bright">{children}</strong>
    ),
    em: ({ children }: { children?: React.ReactNode }) => <em>{children}</em>,
    code: ({ children }: { children?: React.ReactNode }) => (
      <code className="rounded bg-charcoal-700 px-1 py-0.5 text-[11px]">{children}</code>
    ),
  };
}

/** Sanitize image URL to prevent XSS via javascript: or data: URIs. */
function sanitizeImageUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === "https:" || parsed.protocol === "http:") {
      return parsed.href;
    }
    return "";
  } catch {
    return "";
  }
}
