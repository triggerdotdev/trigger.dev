export type LogLevel = "TRACE" | "DEBUG" | "INFO" | "WARN" | "ERROR" | "CANCELLED";

// Convert ClickHouse kind to display level
export function kindToLevel(kind: string, status: string): LogLevel {
  if (status === "CANCELLED") {
    return "CANCELLED";
  }

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
    case "ANCESTOR_OVERRIDE":
    case "SPAN_EVENT":
    default:
      return "TRACE";
  }
}

// Level badge color styles
export function getLevelColor(level: LogLevel): string {
  switch (level) {
    case "ERROR":
      return "text-error bg-error/10 border-error/20";
    case "WARN":
      return "text-warning bg-warning/10 border-warning/20";
    case "DEBUG":
      return "text-charcoal-400 bg-charcoal-700 border-charcoal-600";
    case "INFO":
      return "text-blue-400 bg-blue-500/10 border-blue-500/20";
    case "TRACE":
      return "text-charcoal-500 bg-charcoal-800 border-charcoal-700";
    case "CANCELLED":
      return "text-charcoal-400 bg-charcoal-700 border-charcoal-600";
    default:
      return "text-text-dimmed bg-charcoal-750 border-charcoal-700";
  }
}
