import { CUID_LENGTH, KSUID_LENGTH } from "@trigger.dev/core/v3/isomorphic";

// The body after `<prefix>_` is a base62 id; three generator lengths remain
// valid in existing data and must all be accepted: 21 (nanoid), 25 (cuid),
// 27 (ksuid). cuid/ksuid come from core so this tracks any future change.
const NANOID_BODY_LENGTH = 21;
const VALID_BODY_LENGTHS: ReadonlySet<number> = new Set([
  NANOID_BODY_LENGTH,
  CUID_LENGTH,
  KSUID_LENGTH,
]);

const BASE62 = /^[0-9A-Za-z]+$/;

export function isValidFriendlyId(value: string, prefix: string): boolean {
  const marker = `${prefix}_`;
  if (!value.startsWith(marker)) return false;
  const body = value.slice(marker.length);
  return VALID_BODY_LENGTHS.has(body.length) && BASE62.test(body);
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
