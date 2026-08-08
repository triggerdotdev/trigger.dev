import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type SampleRecord } from "./sampleRecord.js";

/**
 * Snapshots the MIT-licensed Hookdeck webhook-samples dataset (samples.hookdeck.com) into a normalized
 * set of SampleRecords committed to src/generated. Run manually to refresh: `pnpm run ingest`.
 * Attribution lives in NOTICE.md. This is tooling, never imported at runtime.
 */

const BASE = "https://samples.hookdeck.com";
const SNAPSHOT_DATE = "2026-07";
const PRESET_PROVIDERS = new Set(["stripe", "github", "svix", "square", "discord"]);

const HEADER_DENYLIST = new Set([
  "content-type",
  "content-length",
  "host",
  "accept",
  "accept-encoding",
  "accept-language",
  "user-agent",
  "connection",
  "cache-control",
  "pragma",
  "origin",
  "referer",
  "date",
]);

function isNoiseHeader(lower: string): boolean {
  if (HEADER_DENYLIST.has(lower)) return true;
  if (lower.startsWith("sec-") || lower.startsWith("x-forwarded") || lower.startsWith("cf-")) {
    return true;
  }
  return /signature|hmac|authorization|-delivery|hook-id|hook-installation|request-id|webhook-id/.test(
    lower
  );
}

function cleanHeaders(headers: unknown): Record<string, string> | undefined {
  if (typeof headers !== "object" || headers === null) return undefined;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers as Record<string, unknown>)) {
    if (isNoiseHeader(key.toLowerCase())) continue;
    if (typeof value === "string") out[key] = value;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

async function fetchJson(path: string): Promise<unknown> {
  const res = await fetch(`${BASE}${path}`);
  if (!res.ok) throw new Error(`${path} -> ${res.status}`);
  return res.json();
}

type ProviderMeta = { label?: string; latest_version?: string };

async function main() {
  const providers = (await fetchJson("/providers.json")) as Record<string, ProviderMeta>;
  const records: SampleRecord[] = [];

  for (const [provider, meta] of Object.entries(providers)) {
    const version = meta.latest_version;
    if (!version) continue;
    let topics: Record<string, { headers?: unknown; body?: unknown; topic?: string }>;
    try {
      topics = (await fetchJson(`/providers/${provider}/${version}.json`)) as typeof topics;
    } catch (error) {
      console.warn(`skip ${provider}: ${String(error)}`);
      continue;
    }

    for (const [key, entry] of Object.entries(topics)) {
      if (!entry || typeof entry !== "object" || entry.body === undefined) continue;
      const eventType = entry.topic || key;
      records.push({
        provider,
        providerLabel: meta.label,
        presetId: PRESET_PROVIDERS.has(provider)
          ? (provider as SampleRecord["presetId"])
          : undefined,
        eventType,
        name: eventType,
        body: entry.body,
        extraHeaders: cleanHeaders(entry.headers),
        provenance: {
          kind: "upstream",
          ref: `hookdeck/webhook-samples:${provider}/${version}`,
          snapshotDate: SNAPSHOT_DATE,
        },
      });
    }
  }

  records.sort((a, b) =>
    a.provider === b.provider
      ? a.eventType.localeCompare(b.eventType)
      : a.provider.localeCompare(b.provider)
  );

  const here = dirname(fileURLToPath(import.meta.url));
  const outDir = join(here, "generated");
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, "hookdeck-samples.json"), JSON.stringify(records, null, 2) + "\n");

  const providerCount = new Set(records.map((r) => r.provider)).size;
  console.log(`wrote ${records.length} samples across ${providerCount} providers`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
