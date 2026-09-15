import type { ResidencyKind } from "@trigger.dev/core/v3/isomorphic";

/**
 * Where one mint lands. `shardChar` and `region` both occupy index 24 of a run-ops id, so
 * they travel together and cannot disagree. `shardChar` set means gen-2, region ignored.
 */
export type MintTarget = {
  kind: ResidencyKind;
  shardChar?: string;
  region?: string;
};
