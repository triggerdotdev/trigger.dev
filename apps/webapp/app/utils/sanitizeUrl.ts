// Return the URL only if it uses an http(s) scheme, else `undefined` so callers
// can fall back to a default. Use for any URL rendered into an `<a href>`.

const SAFE_HTTP_PROTOCOLS = new Set(["http:", "https:"]);

export function sanitizeHttpUrl(url: string | undefined | null): string | undefined {
  if (!url) return undefined;
  try {
    const parsed = new URL(url);
    return SAFE_HTTP_PROTOCOLS.has(parsed.protocol) ? parsed.href : undefined;
  } catch {
    return undefined;
  }
}
