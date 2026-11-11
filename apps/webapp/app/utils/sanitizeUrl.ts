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

const URL_SCHEME = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;

export function sanitizeLinkTarget(to: string): string | undefined {
  const target = to.replace(/[\t\n\r]/g, "").replace(/^[\u0000- ]+|[\u0000- ]+$/g, "");

  if (URL_SCHEME.test(target)) {
    return sanitizeHttpUrl(target)
      ? target.replace(URL_SCHEME, (scheme) => scheme.toLowerCase())
      : undefined;
  }

  const path = target.split(/[?#]/, 1)[0];
  const hasDotSegments = path.split("/").some((segment) => segment === "." || segment === "..");

  if (
    path.includes("\\") ||
    path.startsWith("//") ||
    (hasDotSegments && (path.includes(":") || path.includes("//")))
  ) {
    return undefined;
  }

  return target;
}
