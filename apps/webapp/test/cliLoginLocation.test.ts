import { describe, expect, it } from "vitest";
import { describeIpLocation } from "~/services/cliLoginNetwork.server";

describe("describeIpLocation", () => {
  it("names the country and the network owner", () => {
    expect(describeIpLocation({ country: "United States", asName: "Google LLC" })).toBe(
      "United States, on Google LLC"
    );
  });

  it("uses whichever part is known", () => {
    expect(describeIpLocation({ country: "Japan", asName: null })).toBe("Japan");
    expect(describeIpLocation({ country: null, asName: "Cloudflare, Inc." })).toBe(
      "on Cloudflare, Inc."
    );
  });

  it("returns undefined when nothing is known", () => {
    expect(describeIpLocation(undefined)).toBeUndefined();
    expect(describeIpLocation({ country: null, asName: null })).toBeUndefined();
    expect(describeIpLocation({ country: "", asName: "" })).toBeUndefined();
  });
});
