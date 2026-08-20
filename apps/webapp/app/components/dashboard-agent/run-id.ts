// Every friendly id the platform mints is `run_` plus a lowercase alphanumeric
// body; see `packages/core/src/v3/isomorphic/friendlyId.ts`.
const RUN_FRIENDLY_ID_PATTERN = /^run_[a-z0-9]+$/i;

export function isRunFriendlyId(value: string): boolean {
  return RUN_FRIENDLY_ID_PATTERN.test(value);
}
