export function extractDomain(input: string): string | null {
  try {
    const withProtocol = input.includes("://") ? input : `https://${input}`;
    const url = new URL(withProtocol);
    return url.hostname;
  } catch {
    return null;
  }
}

export function faviconUrl(domain: string, size: number = 128): string {
  return `https://www.google.com/s2/favicons?domain=${domain}&sz=${size}`;
}
