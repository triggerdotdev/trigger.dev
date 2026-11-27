import { describe, expect, it } from "vitest";
import { replayVersionChoices } from "~/components/runs/v3/replayVersions";
import { versionLabel, versionStanding } from "~/utils/versionLabel";

describe("versionLabel", () => {
  it("tags the current version", () => {
    expect(versionLabel("20261117.3", "20261117.3")).toBe("20261117.3 · Current");
  });

  // Catches: a newer deploy that was skipped for promotion reading like an old version.
  it("tags newer versions as not promoted, across days", () => {
    expect(versionLabel("20261117.4", "20261117.3")).toBe("20261117.4 · Not promoted");
    expect(versionLabel("20261118.1", "20261117.12")).toBe("20261118.1 · Not promoted");
  });

  // Catches: string comparison putting 20261117.10 before 20261117.9.
  it("compares the build number numerically", () => {
    expect(versionStanding("20261117.10", "20261117.9")).toBe("not-promoted");
    expect(versionStanding("20261117.9", "20261117.10")).toBe("older");
  });

  it("leaves older versions and unknown current untagged", () => {
    expect(versionLabel("20261117.2", "20261117.3")).toBe("20261117.2");
    expect(versionLabel("20261117.2", undefined)).toBe("20261117.2");
  });
});

describe("replayVersionChoices", () => {
  it("puts current first and labels the rest", () => {
    expect(replayVersionChoices(["20261117.4", "20261117.3", "20261117.2"], "20261117.3")).toEqual({
      currentLabel: "20261117.3 · Current",
      others: [
        { value: "20261117.4", label: "20261117.4 · Not promoted" },
        { value: "20261117.2", label: "20261117.2" },
      ],
    });
  });

  it("falls back when nothing is current", () => {
    expect(replayVersionChoices(["20261117.1"], undefined).currentLabel).toBe("Current version");
  });
});
