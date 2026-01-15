/**
 * Extracts the client IP address from the X-Forwarded-For header.
 * Takes the last item in the header since ALB appends the real client IP by default.
 */
export function extractClientIp(xff: string | null): string | null {
  if (!xff) return null;

  const parts = xff.split(",").map((p) => p.trim());
  return parts[parts.length - 1]; // take last item, ALB appends the real client IP by default
}
