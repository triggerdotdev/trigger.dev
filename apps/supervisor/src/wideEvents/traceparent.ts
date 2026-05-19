/**
 * Extracts the trace-id from a W3C `traceparent` header. Returns "" when the
 * header is absent, malformed, or carries an all-zero trace-id.
 *
 * Format: `<version>-<trace-id>-<span-id>-<flags>`
 *   version : 2 hex chars, must be "00"
 *   trace-id: 32 hex chars, non-zero
 *   span-id : 16 hex chars (not validated - we only need trace-id)
 *   flags   : 2 hex chars (not validated)
 */
export function parseTraceId(header: string | null | undefined): string {
  if (!header) return "";
  const parts = header.split("-");
  if (parts.length !== 4) return "";
  if (parts[0] !== "00") return "";
  const tid = parts[1];
  if (!tid || tid.length !== 32) return "";
  if (!isHex(tid)) return "";
  if (isAllZero(tid)) return "";
  return tid;
}

function isHex(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    const isDigit = c >= 0x30 && c <= 0x39;
    const isLower = c >= 0x61 && c <= 0x66;
    const isUpper = c >= 0x41 && c <= 0x46;
    if (!isDigit && !isLower && !isUpper) return false;
  }
  return true;
}

function isAllZero(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) !== 0x30) return false;
  }
  return true;
}
