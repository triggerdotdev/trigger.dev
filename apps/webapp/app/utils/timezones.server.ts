export function getTimezones(includeUtc = true) {
  const possibleTimezones = Intl.supportedValuesOf("timeZone").sort();
  if (includeUtc) {
    possibleTimezones.unshift("UTC");
  }
  return possibleTimezones;
}
