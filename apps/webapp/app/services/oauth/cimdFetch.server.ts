import { lookup, type LookupAddress, type LookupAllOptions } from "node:dns";
import { get } from "node:https";
import { isIP } from "node:net";
import type { Readable } from "node:stream";
import { isPublicAddress } from "~/services/publicAddress.server";

const CIMD_TIMEOUT_MS = 5_000;
const CIMD_MAX_BYTES = 64 * 1024;

/** The hostname of a metadata document URL, or null when it must not be fetched. */
export function metadataDocumentHost(url: URL): string | null {
  const hostname = url.hostname
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "")
    .toLowerCase();
  if (!hostname || isIP(hostname) !== 0) return null;
  if (hostname === "localhost" || hostname.endsWith(".localhost")) return null;
  return hostname;
}

/** DNS lookup that refuses to connect to any non-public address. */
export function publicOnlyLookup(
  hostname: string,
  options: { family?: number; all?: boolean } | number,
  callback: (...args: any[]) => void
) {
  const family = typeof options === "number" ? options : options.family;
  const all = typeof options === "object" && options.all === true;
  lookup(hostname, { family, all: true } as LookupAllOptions, (error, addresses) => {
    if (error) return callback(error);
    const list = addresses as LookupAddress[];
    if (list.length === 0 || !list.every((a) => isPublicAddress(a.address))) {
      return callback(new Error(`Refusing to connect to a non-public address for ${hostname}`));
    }
    if (all) return callback(null, list);
    callback(null, list[0].address, list[0].family);
  });
}

type MetadataResponse = {
  status: number;
  body: AsyncIterable<Uint8Array> | Iterable<Uint8Array>;
};
export type MetadataTransport = (url: URL, signal: AbortSignal) => Promise<MetadataResponse>;

/** HTTPS GET that never follows redirects and only connects to public addresses. */
const httpsMetadataTransport: MetadataTransport = (url, signal) =>
  new Promise((resolve, reject) => {
    const request = get(
      url,
      { lookup: publicOnlyLookup as any, signal, headers: { accept: "application/json" } },
      (response) => resolve({ status: response.statusCode ?? 0, body: response })
    );
    request.on("error", reject);
  });

function discard(body: MetadataResponse["body"]): null {
  if ("destroy" in body) (body as Readable).destroy();
  return null;
}

/** Fetches a document body: 200 only, at most CIMD_MAX_BYTES, within CIMD_TIMEOUT_MS. */
export async function fetchMetadataDocumentText(
  url: URL,
  transport: MetadataTransport = httpsMetadataTransport
): Promise<string | null> {
  const signal = AbortSignal.timeout(CIMD_TIMEOUT_MS);
  const response = await transport(url, signal);
  if (response.status !== 200) return discard(response.body);

  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.byteLength;
    if (size > CIMD_MAX_BYTES) return discard(response.body);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}
