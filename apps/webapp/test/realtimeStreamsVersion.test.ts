import { describe, expect, it } from "vitest";
import {
  resolveRealtimeStreamsVersion,
  type RealtimeStreamsVersionConfig,
} from "~/services/realtime/realtimeStreamsVersion";

const NO_S2: RealtimeStreamsVersionConfig = {
  defaultVersion: "v1",
  basin: undefined,
  accessToken: undefined,
  skipAccessTokens: false,
};

const GLOBAL_BASIN: RealtimeStreamsVersionConfig = {
  ...NO_S2,
  basin: "a-basin",
  accessToken: "a-token",
};

const ORG_BASIN: RealtimeStreamsVersionConfig = {
  ...NO_S2,
  basin: "an-org-basin",
  accessToken: "a-token",
};

describe("resolveRealtimeStreamsVersion", () => {
  it("honours an explicit v2 when a global basin is configured", () => {
    expect(resolveRealtimeStreamsVersion("v2", GLOBAL_BASIN)).toBe("v2");
  });

  it("honours an explicit v2 when only an org basin is resolvable", () => {
    expect(resolveRealtimeStreamsVersion("v2", ORG_BASIN)).toBe("v2");
  });

  it("accepts a skip-tokens deployment as credentialed", () => {
    expect(
      resolveRealtimeStreamsVersion("v2", {
        ...NO_S2,
        basin: "a-basin",
        skipAccessTokens: true,
      })
    ).toBe("v2");
  });

  it("degrades an explicit v2 to v1 when S2 is not configured", () => {
    expect(resolveRealtimeStreamsVersion("v2", NO_S2)).toBe("v1");
  });

  it("falls back to the default version when the caller expresses no preference", () => {
    expect(
      resolveRealtimeStreamsVersion(undefined, { ...GLOBAL_BASIN, defaultVersion: "v2" })
    ).toBe("v2");
  });

  it("degrades a v2 default to v1 when S2 is not configured", () => {
    expect(resolveRealtimeStreamsVersion(undefined, { ...NO_S2, defaultVersion: "v2" })).toBe("v1");
  });

  it("keeps a v2 default on v2 when only an org basin is resolvable", () => {
    expect(resolveRealtimeStreamsVersion(undefined, { ...ORG_BASIN, defaultVersion: "v2" })).toBe(
      "v2"
    );
  });

  it("requires credentials, not just a basin", () => {
    const basinOnly = { ...NO_S2, basin: "a-basin", defaultVersion: "v2" as const };
    expect(resolveRealtimeStreamsVersion(undefined, basinOnly)).toBe("v1");
    expect(resolveRealtimeStreamsVersion("v2", basinOnly)).toBe("v1");
  });

  it("requires a basin, not just credentials", () => {
    const tokenOnly = { ...NO_S2, accessToken: "a-token", defaultVersion: "v2" as const };
    expect(resolveRealtimeStreamsVersion(undefined, tokenOnly)).toBe("v1");
    expect(resolveRealtimeStreamsVersion("v2", tokenOnly)).toBe("v1");
  });

  it("keeps an explicit v1 on v1 even where S2 is available", () => {
    expect(resolveRealtimeStreamsVersion("v1", { ...GLOBAL_BASIN, defaultVersion: "v2" })).toBe(
      "v1"
    );
  });

  it("treats an unrecognised version as v1", () => {
    expect(resolveRealtimeStreamsVersion("v3", GLOBAL_BASIN)).toBe("v1");
  });
});

describe("resolveRealtimeStreamsVersion invariant", () => {
  const BASINS = [undefined, "", "a-basin"];
  const TOKENS = [undefined, "a-token"];
  const SKIPS = [false, true];
  const DEFAULTS: Array<"v1" | "v2"> = ["v1", "v2"];
  const REQUESTED = [undefined, "v1", "v2", "v3"];

  it("only returns v2 when a basin and credentials are both present, for every configuration", () => {
    const counterexamples: string[] = [];

    for (const basin of BASINS) {
      for (const accessToken of TOKENS) {
        for (const skipAccessTokens of SKIPS) {
          for (const defaultVersion of DEFAULTS) {
            for (const requested of REQUESTED) {
              const config = { defaultVersion, basin, accessToken, skipAccessTokens };
              const usable = Boolean(basin) && (Boolean(accessToken) || skipAccessTokens);
              if (resolveRealtimeStreamsVersion(requested, config) === "v2" && !usable) {
                counterexamples.push(JSON.stringify({ requested, ...config }));
              }
            }
          }
        }
      }
    }

    expect(counterexamples).toEqual([]);
  });
});
