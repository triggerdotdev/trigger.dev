// Is this string a run's friendly id? Decides whether an agent-supplied
// reference becomes a link to a run page.
//
// Every format the platform mints is `run_` plus a lowercase alphanumeric body
// (see `packages/core/src/v3/isomorphic/friendlyId.ts`), so one pattern covers
// all of them. Case-insensitive because the model may echo an id the user typed
// in caps, and the run page resolves ids case-insensitively anyway. No length
// bound: the formats differ in length, and a false positive only costs a link
// that 404s, which beats rendering a real id as dead text.
export const RUN_FRIENDLY_ID_PATTERN = /^run_[a-z0-9]+$/i;

export function isRunFriendlyId(value: string): boolean {
  return RUN_FRIENDLY_ID_PATTERN.test(value);
}
