// Is this string a run's friendly id? Used to decide whether an agent-supplied
// reference should become a link to a run page.
//
// Every friendly run id the platform mints is `run_` + a lowercase alphanumeric
// body, in all three formats currently in circulation (see
// `packages/core/src/v3/isomorphic/friendlyId.ts`):
//   - nanoid bodies over `123456789abcdefghijkmnopqrstuvwxyz`
//   - run-ops v1 bodies: 26 chars of lowercase base32hex + region + version
//   - legacy `run_<cuid>`, cuid being lowercase alphanumeric
// So one lowercase-alphanumeric pattern covers all of them. It stays
// case-insensitive because the model may echo an id the user typed in caps, and
// the run page resolves ids case-insensitively anyway.
//
// No length bound on purpose: the three formats have different lengths and a
// fourth would too. A false positive costs a link that 404s, which is a much
// smaller failure than silently rendering a real id as dead text.
export const RUN_FRIENDLY_ID_PATTERN = /^run_[a-z0-9]+$/i;

export function isRunFriendlyId(value: string): boolean {
  return RUN_FRIENDLY_ID_PATTERN.test(value);
}
