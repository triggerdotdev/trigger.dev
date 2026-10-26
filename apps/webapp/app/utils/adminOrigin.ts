// ponytail: One extra HTTPS origin while admin access supports both Tailscale and
// localhost. Once Tailscale is canonical, remove this and ADDITIONAL_LOGIN_ORIGINS.
export function createAdminOriginResolver(
  value?: string
): (request: Request) => string | undefined {
  const origin = value ? new URL(value) : undefined;
  if (origin && (origin.protocol !== "https:" || origin.origin !== value || value?.includes(","))) {
    throw new Error("ADDITIONAL_LOGIN_ORIGINS must be one exact HTTPS admin origin");
  }

  return (request) => {
    if (!origin) return undefined;
    const host = request.headers.get("host") ?? new URL(request.url).host;
    try {
      // Only select the configured destination; never trust forwarded headers.
      return new URL(`https://${host}`).origin === origin.origin ? origin.origin : undefined;
    } catch {
      return undefined;
    }
  };
}
