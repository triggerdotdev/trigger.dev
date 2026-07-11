import { CUID_LENGTH, RUN_OPS_ID_LENGTH } from "@trigger.dev/core/v3/isomorphic";

// The body after `<prefix>_` is an alphanumeric id; four generator lengths
// remain valid in existing data and must all be accepted: 21 (nanoid),
// 25 (cuid), 26 (run-ops v1 base32hex), 27 (pre-cutover base62, kept so old
// ids still pass filter validation). cuid/run-ops come from core so this
// tracks any future change.
const NANOID_BODY_LENGTH = 21;
const LEGACY_BASE62_BODY_LENGTH = 27;
const VALID_BODY_LENGTHS: ReadonlySet<number> = new Set([
  NANOID_BODY_LENGTH,
  CUID_LENGTH,
  RUN_OPS_ID_LENGTH,
  LEGACY_BASE62_BODY_LENGTH,
]);

const ALPHANUMERIC = /^[0-9A-Za-z]+$/;

export function isValidFriendlyId(value: string, prefix: string): boolean {
  const marker = `${prefix}_`;
  if (!value.startsWith(marker)) return false;
  const body = value.slice(marker.length);
  return VALID_BODY_LENGTHS.has(body.length) && ALPHANUMERIC.test(body);
}

export function makeFriendlyIdValidator(prefix: string, label: string) {
  const marker = `${prefix}_`;
  return (value: string): string | undefined => {
    if (!value.startsWith(marker)) return `${label} IDs start with '${marker}'`;
    if (!isValidFriendlyId(value, prefix)) {
      return `That doesn't look like a valid ${label.toLowerCase()} ID`;
    }
    return undefined;
  };
}
