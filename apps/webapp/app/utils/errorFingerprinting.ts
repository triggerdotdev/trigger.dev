import { createHash } from "node:crypto";

/**
 * Calculate error fingerprint using Sentry-style normalization.
 * Groups similar errors together by normalizing dynamic values.
 */
export function calculateErrorFingerprint(error: unknown): string {
  if (!error || typeof error !== "object" || Array.isArray(error)) return "";

  // This is a but ugly but…
  // 1. We can't use a schema here because it's a hot path and needs to be fast.
  // 2. It won't be an instanceof Error because it's from the database.
  const errorObj = error as any;
  const errorType = String(errorObj.type || errorObj.name || "Error");
  const message = String(errorObj.message || "");
  const stack = String(errorObj.stack || errorObj.stacktrace || "");

  // Normalize message to group similar errors
  const normalizedMessage = normalizeErrorMessage(message);

  // Extract and normalize first few stack frames
  const normalizedStack = normalizeStackTrace(stack);

  // Create fingerprint from type + normalized message + stack
  const fingerprintInput = `${errorType}:${normalizedMessage}:${normalizedStack}`;

  // Use SHA-256 hash, take first 16 chars for compact storage
  return createHash("sha256").update(fingerprintInput).digest("hex").substring(0, 16);
}

/**
 * Normalize error message by replacing dynamic values with placeholders.
 * This allows similar errors to be grouped together.
 */
export function normalizeErrorMessage(message: string): string {
  if (!message) return "";

  return (
    message
      // UUIDs (8-4-4-4-12 format)
      .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "<uuid>")
      // Run IDs (run_xxxxx format)
      .replace(/run_[a-zA-Z0-9]+/g, "<run-id>")
      // Task run friendly IDs (task_xxxxx or similar)
      .replace(/\b[a-z]+_[a-zA-Z0-9]{8,}\b/g, "<id>")
      // --- Specific patterns must run before generic numeric/path replacements ---
      // ISO 8601 timestamps
      .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z?/g, "<timestamp>")
      // Unix timestamps (10 or 13 digits)
      .replace(/\b\d{10,13}\b/g, "<timestamp>")
      // URLs (before path regex, which would strip the URL's path component)
      .replace(/https?:\/\/[^\s]+/g, "<url>")
      // --- Generic replacements ---
      // Standalone numeric IDs (4+ digits)
      .replace(/\b\d{4,}\b/g, "<id>")
      // File paths (Unix style)
      .replace(/(?:\/[^\/\s]+){2,}/g, "<path>")
      // File paths (Windows style)
      .replace(/[A-Z]:\\(?:[^\\]+\\)+[^\\]+/g, "<path>")
      // Email addresses
      .replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g, "<email>")
      // Memory addresses (0x...)
      .replace(/0x[0-9a-fA-F]{8,}/g, "<addr>")
      // Quoted strings with dynamic content
      .replace(/"[^"]{20,}"/g, '"<string>"')
      .replace(/'[^']{20,}'/g, "'<string>'")
  );
}

/**
 * Normalize stack trace by taking first few frames and removing dynamic parts.
 */
export function normalizeStackTrace(stack: string): string {
  if (!stack) return "";

  // Take first 5 stack frames only
  const lines = stack.split("\n").slice(0, 5);

  return lines
    .map((line) => {
      // Remove line and column numbers (file.ts:123:45 -> file.ts:_:_)
      line = line.replace(/:\d+:\d+/g, ":_:_");
      // Remove standalone numbers
      line = line.replace(/\b\d+\b/g, "_");
      // Remove file paths but keep filename
      line = line.replace(/(?:\/[^\/\s]+)+\/([^\/\s]+)/g, "$1");
      // Normalize whitespace
      line = line.trim();
      return line;
    })
    .filter((line) => line.length > 0)
    .join("|");
}
