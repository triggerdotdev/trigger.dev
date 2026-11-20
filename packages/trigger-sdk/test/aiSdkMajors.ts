import data from "./ai-sdk-majors.json" with { type: "json" };

type KnownFailure = { major: number; file: string; test: string; reason: string };

/**
 * `ai-sdk-majors.json`, with `knownFailures` typed: a JSON import infers an
 * empty list as `never[]`, which its readers cannot use.
 */
export const aiSdkMajors: Omit<typeof data, "knownFailures"> & { knownFailures: KnownFailure[] } =
  data;
