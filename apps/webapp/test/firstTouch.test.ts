import { describe, expect, it } from "vitest";
import { firstTouchFromPostHogProps, parseFirstTouch } from "~/utils/firstTouch";

describe("firstTouchFromPostHogProps", () => {
  // Catches: reading the wrong PostHog keys, so nothing reaches Attio.
  it("maps PostHog's initial props", () => {
    expect(
      firstTouchFromPostHogProps({
        $initial_utm_source: "newsletter",
        $initial_utm_medium: "email",
        $initial_utm_campaign: "launch",
        $initial_referring_domain: "www.google.com",
        $initial_current_url: "https://trigger.dev/?utm_source=newsletter",
        $initial_pathname: "/",
      })
    ).toEqual({
      utmSource: "newsletter",
      utmMedium: "email",
      utmCampaign: "launch",
      referrer: "www.google.com",
      landingPage: "https://trigger.dev/?utm_source=newsletter",
    });
  });

  // Catches: non-string PostHog values being sent as Attio text.
  it("ignores missing or non-string props", () => {
    expect(firstTouchFromPostHogProps(undefined)).toEqual({});
    expect(firstTouchFromPostHogProps({ $initial_utm_source: 42 }).utmSource).toBeUndefined();
  });
});

describe("parseFirstTouch", () => {
  // Catches: query strings (tokens, emails) leaking into the stored landing page.
  it("keeps only the origin and path of the landing page", () => {
    expect(
      parseFirstTouch(
        JSON.stringify({
          utmSource: " newsletter ",
          landingPage: "https://cloud.trigger.dev/login?token=secret#x",
        })
      )
    ).toEqual({ utmSource: "newsletter", landingPage: "https://cloud.trigger.dev/login" });
  });

  // Catches: ids, tokens or emails in the landing page path reaching Attio.
  it("replaces id-like path segments and keeps readable slugs", () => {
    expect(
      parseFirstTouch(
        JSON.stringify({
          landingPage:
            "https://cloud.trigger.dev/invite/cmvz7scvy003qom0j5ipu59te/dev%40example.com/3f2a1b4c-1d2e-4f3a-9b8c-7d6e5f4a3b2c",
        })
      )?.landingPage
    ).toBe("https://cloud.trigger.dev/invite/:id/:id/:id");
    expect(
      parseFirstTouch(
        JSON.stringify({ landingPage: "https://trigger.dev/blog/trigger-v4-launch-2025" })
      )?.landingPage
    ).toBe("https://trigger.dev/blog/trigger-v4-launch-2025");
  });

  // Catches: script URLs or oversized values stored from a tampered form field.
  it("drops non-http landing pages and caps long values", () => {
    const parsed = parseFirstTouch(
      JSON.stringify({ landingPage: "javascript:alert(1)", utmCampaign: "x".repeat(300) })
    );
    expect(parsed).toEqual({ utmCampaign: "x".repeat(200) });
  });

  // Catches: a malformed form field failing the onboarding submit.
  it("returns undefined for empty, invalid or oversized input", () => {
    expect(parseFirstTouch(undefined)).toBeUndefined();
    expect(parseFirstTouch("")).toBeUndefined();
    expect(parseFirstTouch("{}")).toBeUndefined();
    expect(parseFirstTouch("not json")).toBeUndefined();
    expect(parseFirstTouch(JSON.stringify({ utmSource: 5 }))).toBeUndefined();
    expect(parseFirstTouch(JSON.stringify({ utmSource: "a".repeat(6_000) }))).toBeUndefined();
  });
});
