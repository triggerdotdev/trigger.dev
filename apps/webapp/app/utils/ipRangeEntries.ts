import {
  checkIpRangeEntry,
  ipRangesCoveringIp,
  MAX_API_KEY_IP_RANGES,
  TOO_MANY_IP_RANGES_ERROR,
} from "@trigger.dev/rbac/ipRanges";

type Options = { allowPrivateIpRanges: boolean };

/** Split IP ranges input into entries; any whitespace or comma separates them. */
export function splitIpRangesInput(value: FormDataEntryValue | null | undefined): string[] {
  if (typeof value !== "string") return [];
  return value.split(/[\s,]+/).filter(Boolean);
}

// Entries that store as the same range ("1.2.3.4" and "1.2.3.4/32") are one entry.
function entryKey(value: string): string {
  const result = checkIpRangeEntry(value, { allowNonPublicRanges: true });
  return result.ok ? result.range : value.toLowerCase();
}

export type IpRangeCommit = {
  /** The list with every valid, new value added. */
  entries: string[];
  /** Values that can't be added, in order, with the server's message for each. */
  rejected: { value: string; error: string }[];
  /** An entry already in the list that one of the values duplicates. */
  duplicate: string | null;
};

/**
 * Add `values` to an allowlist the way the server validates a save: only valid entries go in,
 * and the list never goes over the limit. Nothing is dropped: what can't be added is returned.
 */
export function commitIpRangeEntries(
  entries: readonly string[],
  values: readonly string[],
  { allowPrivateIpRanges }: Options
): IpRangeCommit {
  const next = [...entries];
  const rejected: IpRangeCommit["rejected"] = [];
  let duplicate: string | null = null;

  for (const value of values) {
    const existing = next.find((entry) => entryKey(entry) === entryKey(value));
    if (existing !== undefined) {
      duplicate = existing;
      continue;
    }
    const result = checkIpRangeEntry(value, { allowNonPublicRanges: allowPrivateIpRanges });
    if (!result.ok) {
      rejected.push({ value, error: result.error });
    } else if (next.length >= MAX_API_KEY_IP_RANGES) {
      rejected.push({ value, error: TOO_MANY_IP_RANGES_ERROR });
    } else {
      next.push(value);
    }
  }

  return { entries: next, rejected, duplicate };
}

/** The message for the first value in `draft` that couldn't be added, or null if all could. */
export function ipRangesDraftError(
  entries: readonly string[],
  draft: string,
  options: Options
): string | null {
  return (
    commitIpRangeEntries(entries, splitIpRangesInput(draft), options).rejected[0]?.error ?? null
  );
}

/** Whether a request from `ip` would pass `entry`, matched as requests are authenticated. */
export function ipRangeCoversIp(entry: string, ip: string): boolean {
  return (ipRangesCoveringIp([entry], ip)?.length ?? 0) > 0;
}
