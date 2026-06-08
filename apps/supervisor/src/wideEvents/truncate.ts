/**
 * Truncate `value` to at most `maxBytes` UTF-8 bytes without splitting a
 * multi-byte sequence or surrogate pair. Plain `.slice()` counts UTF-16 code
 * units, so multibyte text can blow past a byte cap and cutting mid-pair
 * leaves a lone surrogate that downstream JSON / Postgres consumers reject.
 */
export function truncateUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;

  let bytes = 0;
  let end = 0;
  // `for..of` yields whole code points, so a surrogate pair is never split.
  for (const ch of value) {
    const size = Buffer.byteLength(ch, "utf8");
    if (bytes + size > maxBytes) break;
    bytes += size;
    end += ch.length;
  }
  return value.slice(0, end);
}
