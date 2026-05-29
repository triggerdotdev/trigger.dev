/**
 * Validates `next` parameter from Vercel callbacks.
 * Only allows vercel.com subdomains (the expected source) and same-origin relative paths.
 */
export function sanitizeVercelNextUrl(url: string | undefined | null): string | undefined {
  if (!url) return undefined;

  // Allow relative paths (same-origin) but reject protocol-relative URLs
  if (url.startsWith("/") && !url.startsWith("//")) {
    return url;
  }

  try {
    const parsed = new URL(url);
    if (
      parsed.protocol === "https:" &&
      /^([a-z0-9-]+\.)*vercel\.com$/i.test(parsed.hostname)
    ) {
      return parsed.toString();
    }
  } catch {
    // Invalid URL
  }

  return undefined;
}
