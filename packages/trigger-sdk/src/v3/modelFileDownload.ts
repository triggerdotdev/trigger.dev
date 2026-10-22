const MAX_MODEL_FILE_BYTES = 100 * 1024 * 1024;
const MAX_REDIRECTS = 5;

export type ModelFile = { data: Uint8Array; mediaType: string | undefined };

/**
 * Fetches a file for the model from a URL no channel connector owns, with the AI SDK default
 * downloader's protections: only http(s) URLs on public hosts (each redirect is checked too), and a
 * size cap.
 */
export async function fetchPublicFile(
  url: URL,
  maxBytes: number = MAX_MODEL_FILE_BYTES
): Promise<ModelFile> {
  let current = url;
  for (let redirects = 0; ; redirects++) {
    assertPublicUrl(current);
    const res = await fetch(current, { redirect: "manual" });
    const location = res.headers.get("location");
    if (res.status >= 300 && res.status < 400 && location) {
      await res.body?.cancel();
      if (redirects >= MAX_REDIRECTS) {
        throw new Error(`Failed to download ${url.href}: too many redirects`);
      }
      current = new URL(location, current);
      continue;
    }
    if (!res.ok) {
      throw new Error(`Failed to download ${current.href}: ${res.status} ${res.statusText}`);
    }
    return {
      data: await readWithLimit(res, current, maxBytes),
      mediaType: res.headers.get("content-type") ?? undefined,
    };
  }
}

async function readWithLimit(res: Response, url: URL, maxBytes: number): Promise<Uint8Array> {
  const declared = Number(res.headers.get("content-length") ?? 0);
  if (declared > maxBytes) {
    await res.body?.cancel();
    throw new Error(`Failed to download ${url.href}: larger than ${maxBytes} bytes`);
  }
  if (!res.body) return new Uint8Array(await res.arrayBuffer());
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error(`Failed to download ${url.href}: larger than ${maxBytes} bytes`);
    }
    chunks.push(value);
  }
  const data = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    data.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return data;
}

function assertPublicUrl(url: URL): void {
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`Refusing to download ${url.href}: only http and https URLs are fetched`);
  }
  const hostname = url.hostname.toLowerCase().replace(/\.+$/, "");
  const ipv6 =
    hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : undefined;
  const internal =
    !hostname ||
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    (ipv6 !== undefined ? isInternalIPv6(ipv6) : isIPv4(hostname) && isInternalIPv4(hostname));
  if (internal) {
    throw new Error(`Refusing to download ${url.href}: the host is not a public address`);
  }
}

function isIPv4(host: string): boolean {
  const parts = host.split(".");
  return (
    parts.length === 4 &&
    parts.every((part) => {
      const n = Number(part);
      return Number.isInteger(n) && n >= 0 && n <= 255 && String(n) === part;
    })
  );
}

function isInternalIPv4(ip: string): boolean {
  const [a = 0, b = 0, c = 0] = ip.split(".").map(Number);
  return (
    a === 0 ||
    a === 10 ||
    (a === 100 && b >= 64 && b <= 127) ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && c === 0) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 240
  );
}

function parseIPv6(ip: string): number[] | null {
  const address = ip.toLowerCase().split("%")[0]!;
  const halves = address.split("::");
  if (halves.length > 2) return null;
  const toGroups = (segment: string): number[] | null => {
    if (segment === "") return [];
    const groups: number[] = [];
    const parts = segment.split(":");
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i]!;
      if (part.includes(".")) {
        if (i !== parts.length - 1 || !isIPv4(part)) return null;
        const [a = 0, b = 0, c = 0, d = 0] = part.split(".").map(Number);
        groups.push((a << 8) | b, (c << 8) | d);
        continue;
      }
      if (!/^[0-9a-f]{1,4}$/.test(part)) return null;
      groups.push(parseInt(part, 16));
    }
    return groups;
  };
  const head = toGroups(halves[0]!);
  if (head === null) return null;
  if (halves.length === 1) return head.length === 8 ? head : null;
  const tail = toGroups(halves[1]!);
  if (tail === null) return null;
  const fill = 8 - head.length - tail.length;
  if (fill < 0) return null;
  return [...head, ...new Array<number>(fill).fill(0), ...tail];
}

function isInternalIPv6(ip: string): boolean {
  const g = parseIPv6(ip);
  if (g === null) return true;
  const zero = (count: number) => g.slice(0, count).every((group) => group === 0);
  if (zero(7) && (g[7] === 0 || g[7] === 1)) return true;
  const first = g[0]!;
  if ((first & 0xfe00) === 0xfc00) return true;
  if ((first & 0xffc0) === 0xfe80) return true;
  if ((first & 0xffc0) === 0xfec0) return true;
  if ((first & 0xff00) === 0xff00) return true;
  const embedsIPv4 =
    zero(6) ||
    (zero(5) && g[5] === 0xffff) ||
    (zero(4) && g[4] === 0xffff && g[5] === 0) ||
    (first === 0x64 && g[1] === 0xff9b && g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0) ||
    (first === 0x64 && g[1] === 0xff9b && g[2] === 1);
  if (!embedsIPv4) return false;
  const v4 = [g[6]! >> 8, g[6]! & 0xff, g[7]! >> 8, g[7]! & 0xff].join(".");
  return isInternalIPv4(v4);
}
