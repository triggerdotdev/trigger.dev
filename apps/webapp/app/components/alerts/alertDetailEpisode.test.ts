import { describe, expect, it } from "vitest";
import { absenceSilenceStart } from "./alertDetailEpisode";

describe("absenceSilenceStart", () => {
  const raisedAt = new Date("2026-01-01T01:00:00Z");
  const episode = { raisedAt, recoveredAt: null, outcome: "raised" as const };

  it("keeps the episode start while the alert is raised", () => {
    expect(
      absenceSilenceStart({
        status: { status: "needs_attention" },
        episode,
        windowSec: 600,
      })
    ).toEqual(new Date("2026-01-01T00:50:00Z"));
  });

  it("has no silence when the alert is not raised", () => {
    expect(absenceSilenceStart({ status: { status: "active" }, episode })).toBeNull();
  });
});
