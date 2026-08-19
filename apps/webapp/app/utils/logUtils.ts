import { createElement, type ReactNode } from "react";
import { z } from "zod";

export const LogLevelSchema = z.enum(["TRACE", "DEBUG", "INFO", "WARN", "ERROR"]);
export type LogLevel = z.infer<typeof LogLevelSchema>;

// Default styles for search highlighting
const DEFAULT_HIGHLIGHT_STYLES: React.CSSProperties = {
  backgroundColor: "#facc15", // yellow-400
  color: "#000000",
  fontWeight: "500",
  borderRadius: "0.25rem",
  padding: "0 0.125rem",
} as const;

/**
 * Highlights all occurrences of a search term in text with consistent styling.
 * Case-insensitive search with regex special character escaping.
 *
 * @param text - The text to search within
 * @param searchTerm - The term to highlight (optional)
 * @param style - Optional custom inline styles for highlights
 * @returns React nodes with highlighted matches, or the original text if no matches
 */
export function highlightSearchText(
  text: string,
  searchTerm?: string,
  style: React.CSSProperties = DEFAULT_HIGHLIGHT_STYLES
): ReactNode {
  if (!searchTerm || searchTerm.trim() === "") {
    return text;
  }

  // Defense in depth: limit search term length to prevent ReDoS and performance issues
  const MAX_SEARCH_LENGTH = 500;
  if (searchTerm.length > MAX_SEARCH_LENGTH) {
    return text;
  }

  // Escape special regex characters in search term
  const escapedSearch = searchTerm.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const regex = new RegExp(escapedSearch, "gi");

  const parts: ReactNode[] = [];
  let lastIndex = 0;
  let match;
  let matchCount = 0;

  while ((match = regex.exec(text)) !== null) {
    // Add text before match
    if (match.index > lastIndex) {
      parts.push(text.substring(lastIndex, match.index));
    }
    // Add highlighted match
    parts.push(createElement("span", { key: `match-${matchCount}`, style }, match[0]));
    lastIndex = regex.lastIndex;
    matchCount++;
  }

  // Add remaining text
  if (lastIndex < text.length) {
    parts.push(text.substring(lastIndex));
  }

  return parts.length > 0 ? parts : text;
}

// Convert ClickHouse kind to display level
export function kindToLevel(kind: string, status: string): LogLevel {
  // ERROR can come from either kind or status
  if (kind === "LOG_ERROR" || status === "ERROR") {
    return "ERROR";
  }

  switch (kind) {
    case "DEBUG_EVENT":
    case "LOG_DEBUG":
      return "DEBUG";
    case "LOG_INFO":
      return "INFO";
    case "LOG_WARN":
      return "WARN";
    case "LOG_LOG":
      return "INFO"; // Changed from "LOG"
    case "SPAN":
      return "TRACE";
    case "ANCESTOR_OVERRIDE":
    case "SPAN_EVENT":
    default:
      return "INFO";
  }
}

/* Level badge styles. Every chip is a translucent wash of its own accent over
   whatever surface it lands on, so the set reads as one family and follows the
   theme - DEBUG included, which used to be the only solid tile in the row and so
   stayed a dark chip in a white table. Accents come from tokens rather than the
   raw palette so the "Increase color contrast" preference can reach them. */
export function getLevelColor(level: LogLevel): string {
  switch (level) {
    case "ERROR":
      return "text-error bg-error/10 border-error/20";
    case "WARN":
      return "text-warning bg-warning/10 border-warning/20";
    case "TRACE":
      return "text-log-trace bg-log-trace/10 border-log-trace/20";
    case "DEBUG":
      return "text-text-dimmed bg-black/5 border-black/10 dark:bg-white/5 dark:border-white/10";
    case "INFO":
      return "text-pending bg-pending/10 border-pending/20";
    default:
      return "text-text-dimmed bg-black/5 border-black/10 dark:bg-white/5 dark:border-white/10";
  }
}
