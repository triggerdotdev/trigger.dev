const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

function isPrivateIpv4(hostname: string): boolean {
  const octets = hostname.split(".");
  if (octets.length !== 4 || octets.some((o) => !/^\d{1,3}$/.test(o))) {
    return false;
  }

  const [a, b] = octets.map(Number) as [number, number, number, number];
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

// A single-label hostname (no dot) is a container or service name on a private network, which is
// how the self-hosted stack reaches S2, e.g. `http://s2/v1`.
function isPrivateHost(hostname: string): boolean {
  return LOOPBACK_HOSTS.has(hostname) || !hostname.includes(".") || isPrivateIpv4(hostname);
}

// The S2 access token is sent as a bearer header to whatever endpoint is configured, so cleartext
// is only acceptable to a host that is not reachable from the public internet.
export function isValidS2Endpoint(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }

  if (url.protocol === "https:") {
    return true;
  }

  return url.protocol === "http:" && url.hostname !== "" && isPrivateHost(url.hostname);
}
