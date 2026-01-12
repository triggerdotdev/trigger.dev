/**
 * Check if an error is an AbortError.
 *
 * This handles both:
 * - Custom abort errors created with `new Error("AbortError")` (sets .message)
 * - Native Node.js AbortError from timers/promises (sets .name)
 */
export function isAbortError(error: unknown): boolean {
  return (
    error instanceof Error && (error.name === "AbortError" || error.message === "AbortError")
  );
}
