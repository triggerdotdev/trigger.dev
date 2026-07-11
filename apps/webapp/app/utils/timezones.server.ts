export function getTimezones(includeUtc = true) {
  const possibleTimezones = Intl.supportedValuesOf("timeZone").sort();
  if (includeUtc) {
    possibleTimezones.unshift("UTC");
  }
  return possibleTimezones;
}

/**
 * Whether the runtime can resolve this IANA timezone. Prefer this over checking membership
 * in `Intl.supportedValuesOf("timeZone")`, which lists only canonical ids and omits zones
 * browsers legitimately report (e.g. "UTC", "Etc/UTC", "Asia/Kolkata") — rejecting those
 * would leave a client's stored timezone stale.
 */
export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}
