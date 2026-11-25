import { expect, it } from "vitest";
import { redactUrls } from "./analytics";

// Catches: a reader's question in `/docs?q=` reaching PostHog unredacted through $current_url.
it("redacts URL and referrer properties PostHog adds, and leaves the rest", () => {
  const url = "https://trigger.dev/docs/introduction?q=why%20does%20tr_dev_abcdefghijklmnop%20fail";
  const event = redactUrls({
    properties: {
      $current_url: url,
      $referrer: url,
      token: "phc_x",
      $pathname: "/docs/introduction",
    },
    $set_once: { $initial_current_url: "https://trigger.dev/docs?q=alice@example.com" },
  });
  expect(event!.properties!.$current_url).not.toContain("tr_dev_abcdefghijklmnop");
  expect(event!.properties!.$referrer).not.toContain("tr_dev_abcdefghijklmnop");
  expect(event!.$set_once!.$initial_current_url).not.toContain("alice@example.com");
  expect(event!.properties!.token).toBe("phc_x");
  expect(redactUrls(null)).toBeNull();
});
